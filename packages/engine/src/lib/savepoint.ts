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
