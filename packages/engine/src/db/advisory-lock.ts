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
 * holder takes no snapshot and no table lock, so that work never waits on it —
 * nor while it waits for the lock (`waitFor`).
 *
 * Two things end an idle holder early, and either would drop the lock in the
 * middle of the work without a word: the pool's
 * `idle_in_transaction_session_timeout` (lifted here, for the holder only) and
 * Bun's own idle timeout, which closes a reserved connection mid-transaction
 * (measured; the heartbeat keeps it busy). If the holder dies anyway — killed,
 * network — the heartbeat notices and the call rejects with `AdvisoryLockLost`
 * once the work returns: the work cannot be stopped, but its caller must not be
 * told it ran alone.
 *
 * So each call costs two connections at once — the holder's and its work's —
 * and the holders in this process are capped at one below the pool: were every
 * connection a holder, every work would wait for one only another holder's end
 * could free, and none would end. A pool of two, a unique-key reconcile and an
 * extension install were enough. Beyond the cap a caller queues for its turn.
 */

import { type RawBuilder, sql } from 'kysely';
import { activePoolMax, type Database } from './index.js';

// ponytail: one counter for the process, sized from the engine pool every
// holder runs on; a per-pool count if holders ever run on another pool.
let holding = 0;
const waiting: (() => void)[] = [];

async function takeHolderSlot(): Promise<void> {
  while (holding >= Math.max(1, activePoolMax() - 1)) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  holding++;
}

function giveHolderSlot(): void {
  holding--;
  waiting.shift()?.();
}

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

/** The wait for a lock passed `maxWait`: another holder kept it that long. */
export class AdvisoryLockTimeout extends Error {
  constructor(key: AdvisoryKey, maxWait: string) {
    super(`waited ${maxWait} for advisory lock ${String(key)}; another holder still has it`);
    this.name = 'AdvisoryLockTimeout';
  }
}

/**
 * Waits for the lock, then runs `fn` while holding it.
 *
 * `maxWait` (e.g. "10min") bounds the wait on the engine's terms, ending it as
 * `AdvisoryLockTimeout`, so a server or role `statement_timeout` an operator set
 * for queries no longer decides how long a replica waits for a migration.
 * Without it the session's `statement_timeout` / `lock_timeout` bound the wait,
 * ending it with their SQLSTATE, as they did a blocking lock call.
 */
export async function withAdvisoryLock<T>(
  db: Database,
  key: AdvisoryKey,
  fn: () => Promise<T>,
  opts: { maxWait?: string } = {},
): Promise<T> {
  // Never null here: only the try variant gives up.
  return (await hold(db, key, true, fn, opts.maxWait)) as T;
}

/**
 * Runs `fn` under the lock, or returns null at once when another holder has it.
 * "At once" after its turn for a connection: the holder cap queues it first.
 */
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
  maxWait?: string,
): Promise<T | null> {
  await takeHolderSlot();
  try {
    if (!wait) {
      const got = await holdOnce(db, key, fn);
      return got === MISS ? null : got;
    }
    return await waitFor(db, () => holdOnce(db, key, fn), key, maxWait);
  } finally {
    giveHolderSlot();
  }
}

const MISS = Symbol('advisory lock missed');

/**
 * One holder transaction: a try, then `fn` under the lock — or, on a miss, the
 * transaction ends with it. A waiter keeps no transaction open between tries:
 * `CREATE INDEX CONCURRENTLY` waits for every transaction it caught holding a
 * snapshot (`WaitForOlderSnapshots` waits on the virtual xid, so for the whole
 * transaction, not the statement), and one that caught a try of a single long
 * waiting transaction waited on the waiter, the waiter on its holder, until
 * `maxWait` ended it.
 */
async function holdOnce<T>(
  db: Database,
  key: AdvisoryKey,
  fn: () => Promise<T>,
): Promise<T | typeof MISS> {
  let lost: unknown;
  let failed: { err: unknown } | undefined;
  try {
    return await db.transaction().execute(async (holder) => {
      if (!(await tryOnce(holder, sql`pg_try_advisory_xact_lock(${keySql(key)})`, key))) {
        return MISS;
      }
      await sql`SET LOCAL idle_in_transaction_session_timeout = 0`.execute(holder);

      // A beat is a SHOW, which takes no snapshot: a `SELECT` in flight when a
      // `CREATE INDEX CONCURRENTLY` inside `fn` looks would make it wait for this
      // whole transaction, which ends only after `fn` returns.
      let beat: Promise<unknown> = Promise.resolve();
      const timer = setInterval(() => {
        beat = beat
          .then(() => sql`SHOW server_version`.execute(holder))
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

// Literal, not a parameter: a bound statement leaves its portal — and its
// snapshot — open on the holder until the next statement, and every
// `CREATE INDEX CONCURRENTLY` beside it then waits on the holder forever.
function keySql(key: AdvisoryKey): RawBuilder<unknown> {
  return typeof key === 'bigint' ? sql.lit(key) : sql`hashtext(${sql.lit(key)})`;
}

const POLL_MS = 100;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** An interval in milliseconds, as Postgres prints a timeout: digits and a unit, bare digits ms. */
function intervalMs(interval: string): number {
  const m = /^(\d+)(ms|s|min|h|d)?$/.exec(interval);
  if (!m) throw new Error(`maxWait "${interval}" is not an interval like "250ms", "5s" or "2min"`);
  return Number(m[1]) * UNIT_MS[m[2] ?? 'ms']!;
}

/** The error Postgres raised when the blocking lock call ran out of one of its timeouts. */
function cancelled(sqlstate: '57014' | '55P03', message: string): Error {
  return Object.assign(new Error(message), { errno: sqlstate, code: sqlstate });
}

/**
 * Without `maxWait`, the bound the session put on a blocking lock call: its
 * `statement_timeout` (57014) or `lock_timeout` (55P03), whichever is shorter;
 * 0 is none. A wait that is a run of short tries escapes both otherwise, and a
 * stuck holder then hangs every request behind it.
 */
async function sessionBound(on: Database): Promise<{ at: number; err: () => Error }> {
  const { rows } = await sql<{ st: string; lt: string }>`
    SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt
  `.execute(on);
  const st = intervalMs(rows[0]?.st ?? '0');
  const lt = intervalMs(rows[0]?.lt ?? '0');
  const now = Date.now();
  if (st > 0 && (lt === 0 || st <= lt)) {
    return {
      at: now + st,
      err: () => cancelled('57014', 'canceling statement due to statement timeout'),
    };
  }
  if (lt > 0) {
    return {
      at: now + lt,
      err: () => cancelled('55P03', 'canceling statement due to lock timeout'),
    };
  }
  return { at: Infinity, err: () => new Error('unreachable') };
}

/** One try of `tryLock` on `on`: whether it took the lock. */
async function tryOnce(
  on: Database,
  tryLock: RawBuilder<unknown>,
  key: AdvisoryKey,
): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`SELECT ${tryLock} AS ok`.execute(on);
  if (rows[0] === undefined)
    throw new Error(`advisory lock ${String(key)}: the try returned no row`);
  return rows[0].ok;
}

/**
 * Runs `attempt` until it takes the lock, trying again until `maxWait` (without
 * one, until the session's own timeouts, read on `on` — `sessionBound`).
 *
 * Tries, never a blocking `pg_advisory_lock`: a blocked statement keeps its
 * snapshot for the whole wait, and the holder's `CREATE INDEX CONCURRENTLY`
 * waits out every snapshot older than its own. Measured: the holder's build
 * waited for the waiter, the waiter for the holder, until the waiter's
 * lock_timeout ended it — a replica booting into another's `-- NO TRANSACTION`
 * migration. Between two tries the waiter holds none.
 */
async function waitFor<R>(
  on: Database,
  attempt: () => Promise<R | typeof MISS>,
  key: AdvisoryKey,
  maxWait?: string,
): Promise<R> {
  const bound =
    maxWait === undefined
      ? await sessionBound(on)
      : { at: Date.now() + intervalMs(maxWait), err: () => new AdvisoryLockTimeout(key, maxWait) };
  for (;;) {
    const got = await attempt();
    if (got !== MISS) return got;
    if (Date.now() >= bound.at) throw bound.err();
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Takes `key` as a transaction lock inside `trx`, waiting as `withAdvisoryLock`
 * does: for work that already runs in a transaction of its own and needs no holder.
 *
 * Its tries run in `trx`, so a `CREATE INDEX CONCURRENTLY` under the same key
 * that catches one in flight waits for all of `trx` — and `trx` for it — until
 * `maxWait`. Fine for work that never builds concurrently under its key; work
 * that does waits with `withAdvisoryLock` or `withSessionAdvisoryLock`, whose
 * tries end their own transactions.
 */
export async function waitForXactLock(
  trx: Database,
  key: AdvisoryKey,
  maxWait?: string,
): Promise<void> {
  const tryLock = sql`pg_try_advisory_xact_lock(${keySql(key)})`;
  await waitFor(trx, async () => (await tryOnce(trx, tryLock, key)) || MISS, key, maxWait);
}

/**
 * Runs `fn` on one backend, outside any transaction, holding `key` as a SESSION
 * lock on that same backend — for work that needs the lock and refuses a
 * transaction (`CREATE INDEX CONCURRENTLY`). One connection, where a holder
 * needs a second beside its work: under a runtime path's own holder a pool of
 * two has no third.
 *
 * The backend is pinned the only way this dialect pins one, a transaction,
 * committed at once and reopened for Kysely to end. A session lock on a pooled
 * backend is the footgun `withExtensionLock` describes, so it is released in
 * `finally` on the backend that took it, and a backend that cannot release it
 * is ended rather than handed back to the pool still holding it.
 *
 * `fn` runs everything on `session`: another pooled connection would not hold
 * the lock, and at a pool of two there is none to spare.
 */
export async function withSessionAdvisoryLock<T>(
  db: Database,
  key: AdvisoryKey,
  fn: (session: Database) => Promise<T>,
  opts: { maxWait?: string } = {},
): Promise<T> {
  const k = keySql(key);
  return db.transaction().execute(async (pinned) => {
    await sql`COMMIT`.execute(pinned);
    try {
      // Outside a transaction: each try is one of its own.
      const tryLock = sql`pg_try_advisory_lock(${k})`;
      await waitFor(
        pinned,
        async () => (await tryOnce(pinned, tryLock, key)) || MISS,
        key,
        opts.maxWait,
      );
      try {
        return await fn(pinned);
      } finally {
        await sql`SELECT pg_advisory_unlock(${k})`
          .execute(pinned)
          .catch(() => sql`SELECT pg_terminate_backend(pg_backend_pid())`.execute(pinned))
          .catch(() => undefined);
      }
    } finally {
      await sql`BEGIN`.execute(pinned).catch(() => undefined);
    }
  });
}
