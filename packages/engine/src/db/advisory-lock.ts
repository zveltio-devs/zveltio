/**
 * Cross-replica mutual exclusion for work that runs on the pool.
 *
 * The lock is transaction-scoped and lives in a HOLDER transaction, the only
 * thing that pins one backend in this dialect: `db.connection()` does not —
 * outside a transaction each statement goes to whichever pooled backend is
 * free. A session `pg_advisory_lock` taken that way was unlocked on another
 * backend (false, with a warning) and stayed granted on an idle pooled
 * connection; the next replica waited on it. An xact lock cannot outlive its
 * transaction, whatever happens to the caller.
 *
 * The work itself runs on the pool beside the holder, not inside it: migrations
 * open their own transactions, and `CREATE INDEX CONCURRENTLY` refuses one. The
 * holder takes no snapshot and no table lock, so that work never waits on it.
 *
 * Two things end an idle holder early, and either would drop the lock in the
 * middle of the work without a word: the pool's
 * `idle_in_transaction_session_timeout` (lifted here, for the holder only) and
 * Bun's own idle timeout, which closes a reserved connection mid-transaction
 * (measured; the heartbeat keeps it busy). If the holder dies anyway — killed,
 * network — the heartbeat notices and the call rejects with `AdvisoryLockLost`
 * once the work returns: the work cannot be stopped, but its caller must not be
 * told it ran alone.
 */

import { sql } from 'kysely';
import type { Database } from './index.js';

/** A literal bigint key, or a name hashed with `hashtext` (int4, widened). */
export type AdvisoryKey = bigint | string;

export class AdvisoryLockLost extends Error {
  constructor(key: AdvisoryKey, cause: unknown) {
    super(
      `Lost advisory lock ${String(key)} while its work ran: the holder connection died ` +
        `(${(cause as Error)?.message ?? String(cause)}). Another instance may have run beside it.`,
      { cause },
    );
    this.name = 'AdvisoryLockLost';
  }
}

/** Waits for the lock, then runs `fn` while holding it. */
export async function withAdvisoryLock<T>(
  db: Database,
  key: AdvisoryKey,
  fn: () => Promise<T>,
): Promise<T> {
  // Never null here: only the try variant gives up.
  return (await hold(db, key, true, fn)) as T;
}

/** Runs `fn` under the lock, or returns null at once when another holder has it. */
export async function tryAdvisoryLock<T>(
  db: Database,
  key: AdvisoryKey,
  fn: () => Promise<T>,
): Promise<T | null> {
  return hold(db, key, false, fn);
}

async function hold<T>(
  db: Database,
  key: AdvisoryKey,
  wait: boolean,
  fn: () => Promise<T>,
): Promise<T | null> {
  // Literal, not a parameter: a bound statement leaves its portal — and its
  // snapshot — open on the holder until the next statement, and every
  // `CREATE INDEX CONCURRENTLY` beside it then waits on the holder forever.
  const k = typeof key === 'bigint' ? sql.lit(key) : sql`hashtext(${sql.lit(key)})`;
  let lost: unknown;
  let failed: { err: unknown } | undefined;
  try {
    return await db.transaction().execute(async (holder) => {
      await sql`SET LOCAL idle_in_transaction_session_timeout = 0`.execute(holder);
      if (wait) {
        await sql`SELECT pg_advisory_xact_lock(${k})`.execute(holder);
      } else {
        const { rows } = await sql<{ ok: boolean }>`
          SELECT pg_try_advisory_xact_lock(${k}) AS ok
        `.execute(holder);
        if (!rows[0]?.ok) return null;
      }

      let beat: Promise<unknown> = Promise.resolve();
      const timer = setInterval(() => {
        beat = beat
          .then(() => sql`SELECT 1`.execute(holder))
          .catch((err) => {
            lost ??= err;
            clearInterval(timer);
          });
      }, heartbeatMs());
      let value: T;
      try {
        value = await fn();
      } catch (err) {
        failed = { err };
        throw err;
      } finally {
        clearInterval(timer);
        await beat;
      }
      if (lost !== undefined) throw new AdvisoryLockLost(key, lost);
      return value;
    });
  } catch (err) {
    // The rollback on a dead holder throws its own driver error over ours.
    if (failed) throw failed.err;
    if (lost !== undefined) throw new AdvisoryLockLost(key, lost);
    throw err;
  }
}

/** A third of the pool's idle timeout (read as `initDatabase` reads it), so a beat lands first. */
function heartbeatMs(): number {
  const idle = process.env.BUN_SQL_IDLE_TIMEOUT_MS ?? process.env.DB_IDLE_TIMEOUT_MS ?? 300_000;
  return Math.max(100, Number(idle) / 3 || 100_000);
}
