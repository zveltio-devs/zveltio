/**
 * Role windows on one transaction: a statement or two that run under a role
 * other than the transaction's, with the previous role put back after.
 *
 * Windows on one transaction run one at a time. Two interleaved windows read
 * each other's role as "previous": an extension's (`asExtensionDbRole`) could
 * hand the engine back `zveltio_ext`, and the engine's (`asEngineRole`) could
 * hand an extension statement the engine's own login.
 */
import { sql } from 'kysely';
import type { Database } from '../db/index.js';

const windows = new WeakMap<object, Promise<unknown>>();

/**
 * Run `run` after every window already queued on `trx`, and before the next.
 * Keyed by the transaction's executor, not the handle: the engine's view of an
 * extension handle (`engineHandle`) and the request-scoped proxy are other
 * objects on the same transaction, and Kysely gives a transaction one executor.
 */
export function queueRoleWindow<T>(trx: object, run: () => Promise<T>): Promise<T> {
  const key = (trx as { getExecutor?: () => object }).getExecutor?.() ?? trx;
  const mine = (windows.get(key) ?? Promise.resolve()).then(run);
  windows.set(
    key,
    mine.catch(() => undefined),
  );
  return mine;
}

/**
 * Run the engine's own writes to `"user"` as the engine's login role, inside
 * the transaction `db` is on.
 *
 * The request role (`zveltio_rls`) reads `"user"` and writes none of it: god
 * status is its `role` column, and `email` and `banned` decide who signs in, so
 * a write there was one SQL-analyzer miss away from a god (boot revokes it,
 * `ensureRlsEnforcementRole`). The engine still writes it inside the caller's
 * transaction — atomic with its audit row, and without waiting on a row lock
 * that same transaction holds — so it steps out of the request role for the
 * statement and back in. `SET ROLE` is not a sandbox against code that may
 * `RESET ROLE`; what holds is that the analyzer refuses both, as it does for
 * extension windows. On the pool there is nothing to step out of.
 *
 * `run` must not open another window on the same transaction: it would wait
 * for this one.
 */
export function asEngineRole<T>(db: Database, run: () => Promise<T>): Promise<T> {
  const window = async (): Promise<T> => {
    const set = await sql<{ prev: string }>`
      SELECT current_setting('role') AS prev, set_config('role', 'none', true)`.execute(db);
    const restore = () =>
      sql`SELECT set_config('role', ${set.rows[0]?.prev ?? 'none'}, true)`.execute(db);
    try {
      const out = await run();
      await restore();
      return out;
    } catch (err) {
      // A failed statement aborted the transaction (or the savepoint around
      // it), whose rollback restores the role; a JavaScript refusal did not.
      await restore().catch(() => undefined);
      throw err;
    }
  };
  // On `db`'s own transaction, whichever: an engine helper handed an extension's
  // `ctx.adminDb.transaction()` opened its window inside the extension's there.
  return db.isTransaction ? queueRoleWindow(db, window) : run();
}
