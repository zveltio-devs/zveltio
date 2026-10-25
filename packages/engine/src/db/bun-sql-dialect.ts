/**
 * BunSqlDialect — Native Kysely dialect for Bun 1.2+ via Bun.SQL
 *
 * Advantages over `pg`:
 *  - Native Bun I/O (no libuv overhead)
 *  - Native C++ row deserialization (vs JS in pg)
 *  - Built-in connection pool with reserve() for correct transactions
 *  - Zero external dependencies (Bun.SQL is built-in)
 *
 * Requires: Bun >= 1.2, bun-types in devDependencies
 */

import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';

// ─── Internal types for Bun.SQL (bun-types exposes via `Bun` global) ────

/** A reserved connection from Bun.SQL pool (bun >= 1.2) */
interface BunReservedConnection {
  /** Execute raw parameterized SQL — Bun.SQL's escape hatch for $1/$2 style */
  unsafe<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Release the connection back to the pool */
  release(): void;
}

/**
 * How long a request may wait for a pooled connection before being refused.
 *
 * `pool.reserve()` has no timeout of its own, and that is what turned a busy
 * engine into a dead one. Measured: with `DB_POOL_MAX=10`, ten concurrent
 * requests to `/api/data/<c>` did not queue and recover — the engine stopped
 * answering entirely and stayed that way. The process was alive and listening,
 * requests appeared in the log as `<-- GET` and no `-->` ever followed, and
 * Postgres showed no held connections. Only a restart brought it back.
 *
 * Waiting forever is never the right answer for an HTTP request. The caller has
 * its own timeout, so an unbounded wait converts backpressure — which a client
 * can retry — into a hang, which it cannot.
 *
 * Five seconds is well above a healthy request: the same endpoint at fifty
 * concurrent with a wider pool settles at p99 185ms. A wait that long means the
 * pool is saturated, and saying so beats pretending.
 */
const ACQUIRE_TIMEOUT_MS = Number(process.env.DB_ACQUIRE_TIMEOUT_MS ?? 5_000);

/** Thrown when the pool is saturated. Mapped to 503 by the tenant middleware. */
export class PoolBusyError extends Error {
  readonly code = 'pool_busy';
  constructor(waitedMs: number) {
    super(
      `No database connection available after ${waitedMs}ms. The pool is saturated — ` +
        `raise DB_POOL_MAX (against your Postgres max_connections) or reduce concurrency.`,
    );
    this.name = 'PoolBusyError';
  }
}

/**
 * `pool.reserve()` with a deadline.
 *
 * The late-arrival release is the part that matters. Abandoning the promise
 * would leak the connection it eventually resolves to — every timeout would
 * shrink the pool by one, which is the failure this exists to prevent, arriving
 * more slowly. So the losing promise still gets its connection released.
 */
async function reserveWithTimeout(
  pool: BunSQLPool,
  timeoutMs = ACQUIRE_TIMEOUT_MS,
): Promise<BunReservedConnection> {
  const pending = pool.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PoolBusyError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (err) {
    if (err instanceof PoolBusyError) {
      void pending.then(
        (conn) => {
          try {
            conn.release();
          } catch {
            /* already closed — nothing to give back */
          }
        },
        () => {
          /* the reserve itself failed; nothing was handed out */
        },
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * How long a statement outside a transaction waits for its connection.
 *
 * Longer than a request's `ACQUIRE_TIMEOUT_MS` because these callers — boot,
 * jobs, after-commit work — have no client waiting on them. It bounds the wait
 * only: the statement itself is under `statement_timeout`. It used to bound
 * `pool.unsafe()` as a whole, which cannot tell the two apart, and was set above
 * the 30 s statement cap for that reason; it stays at 35 s so a saturated pool
 * fails the same callers at the same moment it always did.
 */
const QUERY_ACQUIRE_TIMEOUT_MS = Number(process.env.DB_QUERY_ACQUIRE_TIMEOUT_MS ?? 35_000);

/** Bun's own check on `pool.unsafe()`, which a reserved connection does not make. */
const OPENS_TRANSACTION = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;

/** Give a reserved connection back; one already closed has nothing to give. */
function releaseReserved(conn: BunReservedConnection): void {
  try {
    conn.release();
  } catch (err) {
    // Bun's pool can race idle-timeout against a transaction release, leaving
    // the connection CLOSED by the time we get here. Any other error must
    // surface so it can be fixed.
    const e = err as { code?: string; message?: string };
    const isClosed =
      e?.code === 'ERR_POSTGRES_CONNECTION_CLOSED' || /Connection closed/i.test(e?.message ?? '');
    if (!isClosed) throw err;
  }
}

/** Main Bun.SQL pool */
interface BunSQLPool {
  /** Execute raw parameterized SQL */
  unsafe<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Reserve a dedicated connection from pool (for transactions) */
  reserve(): Promise<BunReservedConnection>;
  /** Register a handler for LISTEN/NOTIFY */
  subscribe(channel: string, handler: (payload: string) => void): Promise<BunSubscription>;
  /** Close the pool; `timeout` (seconds) force-closes what is still open after it. */
  close(options?: { timeout?: number }): Promise<void>;
}

/**
 * Bun's `close()` with no timeout never resolves once a reserved connection's
 * backend has died (terminated, idle-in-transaction timeout), released or not —
 * measured on 1.3.14. `destroy()` would hang on it.
 */
const CLOSE = { timeout: 5 };

export interface BunSubscription {
  unsubscribe(): Promise<void>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface BunSqlDialectConfig {
  /** Connection string PostgreSQL. Fallback: DATABASE_URL env var. */
  connectionString?: string;
  /**
   * True for the engine's own database, and only for it.
   *
   * A dialect marked primary owns `_activeBunPool` / `_activeDriver`, which are
   * what `recycleActivePool()` throws away after extension migrations and what
   * the worker-extension host queries through. Every other instance — the
   * isolated connections `createDb()` hands to tests and one-off admin work —
   * leaves them alone.
   *
   * Before this flag, whichever dialect initialised LAST owned them. A test that
   * opened its own connection took the engine's handles, and destroying it left
   * them pointing at a dead driver: `recycleActivePool()` returned silently
   * because that driver had no pool, and `getActiveBunPool()` handed out a
   * closed one, while the real database went on serving traffic.
   *
   * @default false
   */
  primary?: boolean;
  /**
   * Maximum connection pool size.
   * @default 20
   */
  max?: number;
  /**
   * Idle timeout for connections (ms).
   * @default 30000
   */
  idleTimeoutMs?: number;
}

// ─── Dialect ─────────────────────────────────────────────────────────────────

export class BunSqlDialect implements Dialect {
  readonly #config: BunSqlDialectConfig;

  constructor(config: BunSqlDialectConfig = {}) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new BunSqlDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    // Reuse PostgreSQL compiler from Kysely — $1/$2 syntax is identical
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

// ─── Module-level pool ref for migration runner ───────────────────────────────
// `unsafe(sql)` with no params uses the simple-query protocol and runs several
// commands, on the pool and on a reserved connection alike (measured, 1.3.14).
export let _activeBunPool: BunSQLPool | null = null;
let _activeDriver: BunSqlDriver | null = null;

/**
 * Drop every pooled connection and its cached plans. See `recyclePool`.
 *
 * A no-op when no driver holds the handles. That used to mean only one thing —
 * nothing had opened a pool, so there were no stale plans to clear and throwing
 * would have made the caller guard a condition that could not matter.
 *
 * It now means a second thing as well. `destroy()` clears the handles it set, so
 * after a primary database is destroyed they are null even though ANOTHER
 * database may still be live and serving; `initDatabase()` has no singleton
 * guard, so a second call takes the handles and destroying that one leaves the
 * first alive with nothing to recycle. Production calls `initDatabase()` once,
 * but the integration and stress lanes call it per file and the CLI's rollback
 * command calls it twice. In that case this really is a silent no-op over a live
 * pool, which is the bug `primary` was added to close and does not fully close.
 */
export async function recycleActivePool(): Promise<void> {
  await _activeDriver?.recyclePool();
  await _registeredPool?.recycle?.();
}

/**
 * The part of a pool the worker-extension SQL bridge uses: one-off statements,
 * and a reserved connection for its transaction. `Bun.SQL`'s pool is one; the
 * `pg` dialect (`ZVELTIO_DB_DRIVER=pg`) registers its own.
 */
export interface RawPool {
  unsafe<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  reserve(): Promise<BunReservedConnection>;
  /** Drop whatever the driver caches against the schema (see `recyclePool`). */
  recycle?(): Promise<void>;
}

let _registeredPool: RawPool | null = null;

/** Called by another driver's primary dialect; null when it is destroyed. */
export function registerActivePool(pool: RawPool | null): void {
  _registeredPool = pool;
}

/** Exposed for the worker-extension-host (C-minimal isolation): worker
 *  RPC `db:query` runs against this pool with the host as gatekeeper. */
export function getActiveBunPool(): RawPool | null {
  return _activeBunPool ?? _registeredPool;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

class BunSqlDriver implements Driver {
  readonly #config: BunSqlDialectConfig;
  #pool: BunSQLPool | null = null;

  constructor(config: BunSqlDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    const url = this.#config.connectionString ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('[BunSqlDialect] connectionString or DATABASE_URL is required');
    }

    let cleanUrl = url.replace(/^(postgres(?:ql)?:\/\/[^@]*@)localhost([:/])/i, '$1127.0.0.1$2');
    let sslEnabled = false;
    try {
      const u = new URL(cleanUrl);
      const sslmode = u.searchParams.get('sslmode') ?? 'disable';
      sslEnabled = sslmode === 'require' || sslmode.startsWith('verify');

      // Drop only what this dialect handles itself. `u.search = ''` used to
      // clear the lot, which silently discarded every other libpq parameter an
      // operator or the engine had set — `options`, `application_name`,
      // `connect_timeout`.
      //
      // That cost real time: `idle_in_transaction_session_timeout` was added to
      // the URL to stop abandoned transactions holding pool connections
      // forever, `SHOW` reported it correctly on a hand-built connection, and
      // the leaked backends kept ageing past the timeout because the engine's
      // pool never received the parameter. The setting was right and arrived
      // nowhere.
      u.searchParams.delete('sslmode');
      cleanUrl = u.toString();
    } catch {
      /* URL parsing failed — use as-is */
    }

    // Bun.SQL not in standard Kysely types — typed `any` for both engine
    // and extensions repo (the latter exposes Bun as `any` per its
    // types/bun-globals.d.ts, so the previous `@ts-expect-error` was
    // unused when typecheck ran cross-repo).
    // Idle timeout default raised to 5min in alpha.126. Studio rebuild
    // spawns a `bun run build` subprocess that can take 5–15 seconds;
    // any in-flight transaction held during that window used to race
    // the previous 30-second idle-eviction and surface as a
    // `connection must be a PostgresSQLConnection` throw from
    // bun:sql's C++ transaction handler. Wider window closes the
    // race in practice. Override via BUN_SQL_IDLE_TIMEOUT_MS for
    // memory-constrained deployments.
    const idleTimeoutMs =
      this.#config.idleTimeoutMs ??
      (process.env.BUN_SQL_IDLE_TIMEOUT_MS ? Number(process.env.BUN_SQL_IDLE_TIMEOUT_MS) : 300_000);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    this.#pool = new (Bun as any).SQL(cleanUrl, {
      max: this.#config.max ?? 20,
      idleTimeout: Math.ceil(idleTimeoutMs / 1000),
      ...(sslEnabled ? {} : { ssl: false, tls: false }),
    }) as BunSQLPool;
    // Only the primary database claims these. See `primary` in the config.
    if (this.#config.primary) {
      _activeBunPool = this.#pool;
      _activeDriver = this;
    }
  }

  /**
   * Throw away every pooled backend and open a fresh pool.
   *
   * Called after extension migrations, at boot and at run time. Those migrations alter
   * tables the ENGINE owns — ten of them today, `zvd_collections` among them —
   * and they run AFTER the boot steps that already queried the database, so the
   * pool is holding prepared plans built against the old shape. The next request
   * to draw such a connection gets `0A000 cached plan must not change result
   * type`, and inside the request transaction the dialect deliberately does not
   * retry, so it surfaces as a 500. Measured in CI: the engine started at
   * 18:52:55.23 and the `ai` extension's migration added three columns to
   * `zvd_collections` at 18:52:56.51.
   *
   * Why a new pool and not `DISCARD ALL`: measured, not assumed. `DISCARD ALL`
   * deallocates server-side while Bun keeps referring to the statement by name,
   * so the very next query fails with `26000 prepared statement … does not
   * exist` — and keeps failing. A fresh pool drops both sides at once.
   *
   * At run time (an enable, an upgrade, a purge) transactions are open on the
   * old pool — the enable's own advisory-lock holder among them. So the old pool
   * is closed gracefully and not awaited: Bun lets each open transaction finish
   * and then closes the old pool's connections, idle ones included (measured) —
   * so for that moment up to twice the pool is open, inside the half of
   * `max_connections` the autosizer leaves. `close(CLOSE)` force-closed them
   * after five seconds — measured: the holder's COMMIT then fails — and awaiting
   * it stalled the enable for those seconds. A close that never resolves (a dead
   * reserved backend, see `CLOSE`) keeps the old pool's connections open.
   */
  async recyclePool(): Promise<void> {
    if (!this.#pool) return;
    // New pool first: a query arriving meanwhile must find a pool, not a
    // driver that throws "not initialized".
    const old = this.#pool;
    await this.init();
    void old.close().catch(() => {});
  }

  /**
   * Returns a smart connection that reserves a backend per statement, and for
   * the whole transaction once one begins — so a connection is held only while
   * something runs on it.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#pool) throw new Error('[BunSqlDriver] Driver not initialized. Call initDatabase().');
    return new BunSqlSmartConnection(() => this.getPool());
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    // Upgrade to reserved connection before sending BEGIN
    await (connection as BunSqlSmartConnection).reserveForTransaction();
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
    (connection as BunSqlSmartConnection).markInTransaction(true);
    if (settings.isolationLevel) {
      await connection.executeQuery(
        CompiledQuery.raw(
          `SET TRANSACTION ISOLATION LEVEL ${settings.isolationLevel.toUpperCase()}`,
        ),
      );
    }
    // Kysely's own Postgres dialect honours this; dropping it would run a
    // transaction asked to be read-only as read-write.
    if (settings.accessMode) {
      await connection.executeQuery(
        CompiledQuery.raw(`SET TRANSACTION ${settings.accessMode.toUpperCase()}`),
      );
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
    (connection as BunSqlSmartConnection).markInTransaction(false);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
    (connection as BunSqlSmartConnection).markInTransaction(false);
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as BunSqlSmartConnection).release();
  }

  async destroy(): Promise<void> {
    if (this.#pool) {
      await this.#pool.close(CLOSE);
      this.#pool = null;
    }
    // Clear the module-level handles this driver set in `init()`.
    //
    // Without this they drift, and both consequences are silent:
    //
    //   `recycleActivePool()` becomes a no-op. It calls `recyclePool()`, which
    //   opens with `if (!this.#pool) return;` — so after a destroy there is
    //   nothing to recycle and it returns without saying so. That function is
    //   the fix for `0A000 cached plan must not change result type`: extension
    //   migrations alter engine-owned tables at boot, and the pool must be
    //   thrown away so no prepared plan outlives them. A no-op there brings the
    //   bug back.
    //
    //   `getActiveBunPool()` keeps handing out a CLOSED pool. The
    //   worker-extension host runs its `db:query` RPC through exactly that
    //   handle.
    //
    // It surfaced as a harness test that failed in CI and never locally:
    // `expect(after).not.toBe(before)` — the pool was the same object, because
    // an earlier file in that run had destroyed the driver and the globals
    // still pointed at its closed pool. Different file order, different result,
    // which is why it looked like flakiness.
    //
    // Guarded by identity: a second driver may have initialised since, and it
    // must keep its own handles.
    if (_activeDriver === this) {
      _activeDriver = null;
      _activeBunPool = null;
    }
  }

  /** Exposes pool for LISTEN/NOTIFY (used by RealtimeManager) */
  getPool(): BunSQLPool {
    if (!this.#pool) throw new Error('[BunSqlDriver] Pool not initialized.');
    return this.#pool;
  }
}

/**
 * JS arrays as Postgres array literals (`{"a","b",NULL}`).
 *
 * Bun's `unsafe()` sends a JS array as its comma-joined text, so `= ANY($1)`
 * failed with a protocol error and a `text[]` column with `malformed array
 * literal`. Shared by Kysely's queries and the worker SQL bridge, so an
 * extension's array parameter means the same thing inline and out of process.
 *
 * Nested arrays become a multidimensional literal (`{{"1","2"},{"3","4"}}`) and
 * object elements their JSON text, so `jsonb[]` round-trips. A JS array meant
 * for a single `jsonb` value is indistinguishable from a `text[]` one here:
 * pass `JSON.stringify(value)` with a `::text::jsonb` cast for that.
 */
export function encodeArrayParams(params: readonly unknown[]): unknown[] {
  return params.map((p) => (Array.isArray(p) ? arrayLiteral(p) : p));
}

function arrayLiteral(items: readonly unknown[]): string {
  const parts = items.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    if (Array.isArray(item)) return arrayLiteral(item);
    const s =
      item instanceof Date
        ? item.toISOString()
        : Buffer.isBuffer(item)
          ? `\\x${item.toString('hex')}`
          : typeof item === 'object'
            ? JSON.stringify(item)
            : String(item);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

// ─── Param inlining (simple-query fallback) ─────────────────────────────────
/** Postgres-style literal escape used as a last-resort fallback when prepared
 *  statements fail with SQLSTATE 0A000. Inputs are values Kysely produced from
 *  TypeScript code — strings, numbers, booleans, dates, null. We never reach
 *  here for arbitrary user SQL, so this is safe by construction. */
function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  // Object → JSON literal (jsonb columns)
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

function inlineParams(sql: string, params: unknown[]): string {
  if (params.length === 0) return sql;
  // Replace $1, $2, … with quoted literals. We walk the string once and skip
  // over single-quoted strings and SQL comments to avoid corrupting them.
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // pass-through string literal
    if (ch === "'") {
      const start = i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    // pass-through line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl + 1;
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    // $n parameter
    if (ch === '$' && sql[i + 1] >= '0' && sql[i + 1] <= '9') {
      let j = i + 1;
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j++;
      const idx = parseInt(sql.slice(i + 1, j), 10) - 1;
      if (idx >= 0 && idx < params.length) {
        out += quoteLiteral(params[idx]);
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ─── Connection ──────────────────────────────────────────────────────────────

/**
 * Smart connection:
 * - Normal queries: a connection reserved for the one statement (see `#run`).
 * - Transactions: reserves a dedicated connection on beginTransaction so that
 *   BEGIN / queries / COMMIT all run on the same PostgreSQL backend socket.
 */
class BunSqlSmartConnection implements DatabaseConnection {
  /**
   * The driver's pool AT EACH USE, not at acquire: a recycle on a running
   * engine closes the old pool, which then refuses every new statement.
   */
  readonly #pool: () => BunSQLPool;
  #reserved: BunReservedConnection | null = null;
  /** True between BEGIN and COMMIT/ROLLBACK. Read by `release()`. */
  #inTransaction = false;
  /**
   * Set once this connection has raised `0A000`. From then on it stops using
   * prepared statements, which is the only thing that can raise it.
   *
   * The alternative — a SAVEPOINT before every statement so the retry becomes
   * legal — costs a round trip on every query inside a transaction, forever, to
   * protect against something most connections never see. This costs nothing
   * until it happens and nothing that matters afterwards: the simple-query path
   * skips the plan cache, so it cannot go stale.
   */
  #skipPrepared = false;

  constructor(pool: () => BunSQLPool) {
    this.#pool = pool;
  }

  /** Called by beginTransaction() to pin a backend connection. */
  async reserveForTransaction(): Promise<void> {
    if (this.#reserved) return;
    this.#reserved = await reserveWithTimeout(this.#pool());
  }

  /**
   * Wrap Bun's result array as a Kysely `QueryResult`, carrying the affected-row
   * count across.
   *
   * Kysely reads `numAffectedRows` to build `DeleteResult.numDeletedRows` and
   * `UpdateResult.numUpdatedRows`. This dialect returned `{ rows }` and nothing
   * else, so both were `undefined` — and the idiom every caller reaches for,
   * `(res?.numDeletedRows ?? 0n) === 0n`, therefore read as "nothing matched"
   * on a delete that had just removed the row.
   *
   * Eight route handlers across four extensions answered 404 to a DELETE that
   * succeeded. The caller sees "Not found", retries, gets 404 again, and
   * concludes the row is undeletable — while it is already gone.
   *
   * Bun's array carries `count` and `command`; this only has to pass them on.
   * `count` is the row count for a SELECT too, which Kysely ignores there.
   */
  static #wrap<R>(rows: R[]): QueryResult<R> {
    const count = (rows as unknown as { count?: number }).count;
    return typeof count === 'number' ? { rows, numAffectedRows: BigInt(count) } : { rows };
  }

  /**
   * One statement: on the transaction's connection, or else on one reserved for
   * this statement alone — never through `pool.unsafe()`.
   *
   * `Bun.SQL` 1.3.14 runs a `pool.unsafe()` statement INSIDE another caller's
   * reserved transaction once demand passes `max`. Its `release()` hands a
   * drained connection to a waiting `reserve()` without taking it out of
   * `readyConnections`, and `flushConcurrentQueries()` then pipelines pool
   * statements onto it. Measured with `max: 10` and 24 callers: a pool statement
   * read another transaction's `SET LOCAL` setting, and within a few bursts the
   * pool stalled — the pool statement waits for the transaction to end, the
   * transaction's next statement waits behind it — until the 35 s deadline.
   * In the engine that is a request's tenant GUCs and role leaking into a query
   * outside it, and the 30 s schema-dev-writer timeouts after a pool recycle.
   * Only `pool.unsafe()` feeds that queue, so reserving every statement keeps it
   * empty. Bun 1.4 rewrote the pool (a reservation leaves `readyConnections`);
   * re-measure `tests/harness/bun-pool-isolation.test.ts` before going back.
   */
  async #run<R>(sql: string, params: unknown[]): Promise<R[]> {
    const exec = (conn: BunReservedConnection) =>
      params.length > 0 ? conn.unsafe<R>(sql, params) : conn.unsafe<R>(sql);
    if (this.#reserved) return exec(this.#reserved);
    // A transaction opened here would go back to the pool still open.
    if (OPENS_TRANSACTION.test(sql)) {
      throw new Error('[BunSqlDialect] open a transaction with db.transaction(), not a raw BEGIN');
    }
    const conn = await reserveWithTimeout(this.#pool(), QUERY_ACQUIRE_TIMEOUT_MS);
    try {
      return await exec(conn);
    } finally {
      releaseReserved(conn);
    }
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const params = encodeArrayParams(compiledQuery.parameters as unknown[]);

    const runPrepared = async (): Promise<QueryResult<R>> =>
      BunSqlSmartConnection.#wrap(await this.#run<R>(compiledQuery.sql, params));

    /** Last-resort fallback after a prepared-statement failure: inline the
     *  params into the SQL and run via simple-query protocol (no prepare,
     *  no plan cache). Postgres' libpq-level escaping of literals is what
     *  we duplicate here — values are URL-safe primitives Kysely produced. */
    const runInline = async (): Promise<QueryResult<R>> => {
      const inlined = inlineParams(compiledQuery.sql, params);
      return BunSqlSmartConnection.#wrap(await this.#run<R>(inlined, []));
    };

    if (this.#skipPrepared) return runInline();

    try {
      return await runPrepared();
    } catch (err) {
      // Postgres SQLSTATE 0A000 — "cached plan must not change result type"
      // is raised when a prepared statement's result schema no longer matches
      // the underlying table (DDL ran since the plan was prepared). The Bun
      // pool keeps prepared statements alive per backend connection, so a
      // single retry only succeeds if the next acquire happens to land on a
      // different connection. We retry once with prepared, then fall back to
      // simple-query (no prepare, no cache) which can never hit this issue.
      // `errno` carries the SQLSTATE on this driver; `code` carries the generic
      // marker `ERR_POSTGRES_SERVER_ERROR`. Reading only `code` made this test
      // always false, so the whole 0A000 recovery below -- retry, then
      // simple-query fallback, written to close 8 failures in 19 E2E runs --
      // hung on the message regex beside it. It worked, which is why nobody
      // noticed; it would stop working the moment the server's message text
      // differed. `ERR_POSTGRES_CONNECTION_CLOSED` in `release()` below is
      // genuinely a `code`, and stays one.
      const e = err as { code?: string; errno?: string; message?: string } | undefined;
      const isCachedPlan =
        e?.errno === '0A000' ||
        e?.code === '0A000' ||
        /cached plan must not change result type/i.test(e?.message ?? '');
      if (!isCachedPlan) throw err;

      // Inside a transaction the retry cannot work, and trying destroys the
      // evidence.
      //
      // `0A000` is a failed statement like any other, so Postgres has already
      // aborted the transaction. The retry below then answers `25P02 current
      // transaction is aborted`, `stillCached` is false, and THAT is what gets
      // thrown — so the caller, the request log and Kysely's error hook all see
      // 25P02 and nothing else. The real cause never surfaces anywhere.
      //
      // That is how it read from the outside: an intermittent 500 with
      // `25P02` and no failed statement before it in the trace, on
      // `select * from "zvd_collections" where "name" = $1` — a prepared
      // statement against a table the collection-create path is busy altering,
      // which is exactly what raises `0A000`. E2E failed that way in 8 of 19
      // runs, on a different endpoint each time.
      //
      // Outside a transaction the retry is still right: each statement is its
      // own transaction, so nothing is aborted and a second attempt — or the
      // simple-query fallback — genuinely recovers.
      // Whatever happens to this statement, stop preparing on this connection.
      // A stale plan is not a one-off: the same cached plan is reused until the
      // backend goes away, so the next request to draw this connection meets it
      // again. Turning the plan cache off for this connection makes the failure
      // non-recurring instead of periodic.
      this.#skipPrepared = true;

      if (this.#inTransaction) throw err;

      try {
        return await runPrepared();
      } catch (err2) {
        const e2 = err2 as { code?: string; errno?: string; message?: string } | undefined;
        const stillCached =
          e2?.errno === '0A000' ||
          e2?.code === '0A000' ||
          /cached plan must not change result type/i.test(e2?.message ?? '');
        if (!stillCached) throw err2;
        return runInline();
      }
    }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('[BunSqlConnection] streamQuery is not supported in BunSqlDialect');
  }

  /** Set by the driver around BEGIN and COMMIT/ROLLBACK. */
  markInTransaction(v: boolean): void {
    this.#inTransaction = v;
  }

  release(): void {
    if (this.#reserved) {
      // A transaction still open here means the request was abandoned before
      // Kysely could COMMIT or ROLLBACK — Bun.serve giving up on a slow handler,
      // a client disconnecting, an acquire deadline firing upstream.
      //
      // Releasing it as-is is what poisoned the pool. `SET LOCAL ROLE
      // zveltio_rls` only unwinds when the transaction ENDS, so a connection
      // returned mid-transaction carries the downgraded role into whoever
      // borrows it next — and that borrower is often Better Auth, which then
      // answers `permission denied for table session` and aborts ITS caller's
      // transaction in turn. Measured: 129 session reads all correctly on
      // `pool.unsafe`, and still failing, because the pool itself was dirty.
      //
      // Fire-and-forget because `release()` is synchronous and Kysely gives no
      // async hook here; the connection is not handed back until the ROLLBACK
      // resolves, and if it rejects the connection is closed rather than reused.
      if (this.#inTransaction) {
        this.#inTransaction = false;
        const conn = this.#reserved;
        this.#reserved = null;
        void (async () => {
          try {
            await conn.unsafe('ROLLBACK');
            conn.release();
          } catch {
            try {
              (conn as unknown as { close?: () => void }).close?.();
            } catch {
              /* nothing left to try */
            }
          }
        })();
        return;
      }
      releaseReserved(this.#reserved);
      this.#reserved = null;
    }
    // No-op for non-transaction connections — pool manages itself
  }
}
