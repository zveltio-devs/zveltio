/**
 * Run a query that is allowed to fail, without taking the transaction with it.
 *
 * Postgres aborts the whole transaction on ANY failed statement. A JavaScript
 * `catch` does not undo that: every later statement on the connection answers
 * `25P02 current transaction is aborted, commands ignored until end of
 * transaction block` — including statements belonging to a DIFFERENT request,
 * once the connection goes back to the pool.
 *
 * Not theory. Traced in CI on 2026-08-28: a `SELECT` on a table belonging to an
 * uninstalled extension failed inside `POST /api/data/…`, was caught and
 * reported as "no rules", and a later `GET` on the same collection died on its
 * FIRST statement having done nothing wrong. E2E failed that way in 8 of 19
 * runs, on a different endpoint each time, which is why it read as flake.
 *
 * A SAVEPOINT scopes the damage: the failed statement is undone and the outer
 * transaction stays usable. Same tool `emitAsync` uses for extension listeners,
 * for the same reason.
 *
 * Prefer NOT failing at all where the failure is predictable — probe for the
 * table or the role once and skip the statement, as `getRuleGroups` now does.
 * This is for the rest: a fallback that must survive a fault it cannot foresee.
 *
 * ONLY call this where the handle is genuinely inside a transaction.
 *
 * Outside one, `SAVEPOINT` raises `25P01 SAVEPOINT can only be used in
 * transaction blocks` — and on this driver a failed statement leaves the pooled
 * connection unusable for whoever draws it next. Measured: wrapping
 * `resolveUserRole`, which holds the POOL handle, produced thirteen consecutive
 * 25P01s and then a `25P02` on an unrelated request. The guard had become the
 * thing it exists to prevent. Middleware that runs inside `tenantMiddleware` is
 * the safe case; a module-level `_db` set at boot is not.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';

/**
 * `SAVEPOINT` is only legal inside a transaction block. Outside one every
 * statement is its own transaction, a failure poisons nothing, and there is
 * nothing to protect — but issuing the savepoint would itself raise. Rather
 * than ask Postgres whether we are in a transaction (no portable, race-free way
 * from here), try it and read the refusal as "not needed".
 */
export async function withSavepoint<T>(
  db: Database,
  name: string,
  run: () => Promise<T>,
  onFailure: (err: unknown) => T,
): Promise<T> {
  let guarded = true;
  try {
    // raw-ident-ok: `name` is a literal at every call site, never caller input.
    await sql.raw(`SAVEPOINT ${name}`).execute(db);
  } catch {
    // Tried on every call, deliberately, and NOT remembered per handle.
    //
    // The handle core routes hold is a proxy that resolves to the request's
    // tenant transaction when there is one and to the pool when there is not —
    // the same JavaScript object either way. Caching "this handle refuses
    // SAVEPOINT" would therefore switch the guard off for every later request
    // that IS in a transaction, which is the case it exists for. A refused
    // SAVEPOINT costs one round trip and poisons nothing: outside a transaction
    // every statement is its own, which is why there was nothing to guard.
    guarded = false;
  }

  try {
    const value = await run();
    // raw-ident-ok: same literal as above.
    if (guarded) await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(db);
    return value;
  } catch (err) {
    if (guarded) {
      // Undo the failed statement. Without this the caller's fallback value is
      // handed back on a connection that will refuse everything after it.
      // raw-ident-ok: same literal as above.
      await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(db);
    }
    return onFailure(err);
  }
}

/** Kysely's TransactionBuilder, as a handle that joins a running transaction offers it. */
export interface JoinedTransactionBuilder {
  setIsolationLevel(level: string): JoinedTransactionBuilder;
  setAccessMode(mode: string): JoinedTransactionBuilder;
  execute<T>(fn: (t: Database) => Promise<T>): Promise<T>;
}

/**
 * `db.transaction()` on a handle that JOINS the running transaction `trx`
 * (request-scoped db, an extension's `ctx.db`) rather than opening one.
 *
 * Both builder options used to be accepted and dropped: a caller asking for
 * read-only got read-write, one asking for SERIALIZABLE got the request's READ
 * COMMITTED, and neither was told. Now:
 *
 *   - `setAccessMode('read only')` is real: `SET TRANSACTION READ ONLY` right
 *     after a SAVEPOINT. Postgres puts the flag back when the subtransaction
 *     ends, released or rolled back, so the scope is read-only and `trx` is not.
 *   - `setIsolationLevel` must name the level `trx` already runs at; anything
 *     else is refused, because Postgres cannot change it mid-transaction.
 *
 * `join` runs the body; `scoped` says it must be inside a savepoint (read-only).
 */
export function joinedTransactionBuilder(
  trx: Database,
  handle: Database,
  join: <T>(body: () => Promise<T>, scoped: boolean) => Promise<T>,
): JoinedTransactionBuilder {
  let readOnly = false;
  let level: string | undefined;
  const builder: JoinedTransactionBuilder = {
    setIsolationLevel(l) {
      level = l;
      return builder;
    },
    setAccessMode(m) {
      readOnly = m === 'read only';
      return builder;
    },
    async execute(fn) {
      if (level !== undefined) await assertJoinedIsolation(trx, level);
      return join(async () => {
        if (readOnly) await sql`SET TRANSACTION READ ONLY`.execute(trx);
        return fn(handle);
      }, readOnly);
    },
  };
  return builder;
}

async function assertJoinedIsolation(trx: Database, asked: string): Promise<void> {
  const r = await sql<{ l: string }>`SELECT current_setting('transaction_isolation') AS l`.execute(
    trx,
  );
  const running = r.rows[0]?.l ?? '';
  // Postgres runs READ UNCOMMITTED as READ COMMITTED.
  const norm = (l: string) => l.toLowerCase().replace('read uncommitted', 'read committed');
  if (norm(String(asked)) !== norm(running)) {
    throw new Error(
      `db.transaction().setIsolationLevel('${asked}') joins a transaction already running ` +
        `${running.toUpperCase()}, and Postgres cannot change the isolation level of a ` +
        'running transaction. Drop the call, or run this work outside the request.',
    );
  }
}
