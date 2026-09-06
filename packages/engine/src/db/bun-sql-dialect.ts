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
async function reserveWithTimeout(pool: BunSQLPool): Promise<BunReservedConnection> {
  const pending = pool.reserve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PoolBusyError(ACQUIRE_TIMEOUT_MS)), ACQUIRE_TIMEOUT_MS);
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
 * A pool query that cannot wait forever.
 *
 * `pool.unsafe()` queues when every connection is reserved, with no deadline of
 * its own — measured directly: reserve every connection inside a transaction,
 * then call `unsafe()`, and it is still waiting when the test gives up. Same
 * defect `reserveWithTimeout` fixed for transactions, on the path that
 * non-transactional queries take.
 *
 * The threshold sits ABOVE `statement_timeout` (30s on these connections), and
 * that is the design rather than a rounded number. Bun does not separate
 * "waiting for a connection" from "statement running", so a shorter deadline
 * would abandon statements that are legitimately executing — and an abandoned
 * INSERT still commits, leaving its caller told it failed. Above the statement
 * cap, a timeout can only mean a connection never arrived, so nothing is ever
 * abandoned mid-flight.
 *
 * It is a stop against hanging forever, not a latency control. 35s is a bad
 * wait; an unbounded one is worse — the request never ends, the client gives up,
 * and the promise stays pinned in the process.
 */
const QUERY_ACQUIRE_TIMEOUT_MS = Number(process.env.DB_QUERY_ACQUIRE_TIMEOUT_MS ?? 35_000);

/** Reject with `PoolBusyError` if `p` has not settled by the deadline. */
function withQueryDeadline<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PoolBusyError(QUERY_ACQUIRE_TIMEOUT_MS)),
      QUERY_ACQUIRE_TIMEOUT_MS,
    );
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Main Bun.SQL pool */
interface BunSQLPool {
  /** Execute raw parameterized SQL */
  unsafe<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Reserve a dedicated connection from pool (for transactions) */
  reserve(): Promise<BunReservedConnection>;
  /** Register a handler for LISTEN/NOTIFY */
  subscribe(channel: string, handler: (payload: string) => void): Promise<BunSubscription>;
  /** Close the pool and all connections */
  close(): Promise<void>;
}

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

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

// ─── Module-level pool ref for migration runner ───────────────────────────────
// pool.unsafe(sql) (no params) uses PostgreSQL simple-query protocol and
// supports multiple commands. reserved.unsafe(sql) always uses extended-query
// protocol (prepared statements) even without params, which forbids multiple
// commands. Migrations need simple-query, so they use this reference directly.
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
}

/** Exposed for the worker-extension-host (C-minimal isolation): worker
 *  RPC `db:query` runs against this pool with the host as gatekeeper. */
export function getActiveBunPool(): BunSQLPool | null {
  return _activeBunPool;
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
   * Called once at boot, after extension migrations. Those migrations alter
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
   * Safe where it is called: extension loading is awaited, and `Bun.serve` has
   * not started, so nothing is mid-request.
   */
  async recyclePool(): Promise<void> {
    if (!this.#pool) return;
    const old = this.#pool;
    this.#pool = null;
    await old.close().catch(() => {});
    await this.init();
  }

  /**
   * Returns a smart connection that uses pool.unsafe() directly for normal
   * queries (no reservation) and lazily reserves a connection only when a
   * transaction begins. This prevents pool exhaustion — reserve() pins a
   * dedicated backend connection; using it for every query drains max quickly.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#pool) throw new Error('[BunSqlDriver] Driver not initialized. Call initDatabase().');
    return new BunSqlSmartConnection(this.#pool);
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
      await this.#pool.close();
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
 * - Normal queries: routes through pool.unsafe() — no connection reservation,
 *   pool manages concurrency efficiently.
 * - Transactions: reserves a dedicated connection on beginTransaction so that
 *   BEGIN / queries / COMMIT all run on the same PostgreSQL backend socket.
 */
class BunSqlSmartConnection implements DatabaseConnection {
  readonly #pool: BunSQLPool;
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

  constructor(pool: BunSQLPool) {
    this.#pool = pool;
  }

  /** Called by beginTransaction() to pin a backend connection. */
  async reserveForTransaction(): Promise<void> {
    if (this.#reserved) return;
    this.#reserved = await reserveWithTimeout(this.#pool);
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

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const params = (compiledQuery.parameters as unknown[]).map((p) => {
      if (!Array.isArray(p)) return p;
      const escaped = (p as unknown[]).map((item) => {
        if (item === null || item === undefined) return 'NULL';
        const s = String(item);
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      });
      return `{${escaped.join(',')}}`;
    });

    const runPrepared = async (): Promise<QueryResult<R>> => {
      if (this.#reserved) {
        const rows =
          params.length > 0
            ? await this.#reserved.unsafe<R>(compiledQuery.sql, params)
            : await this.#reserved.unsafe<R>(compiledQuery.sql);
        return BunSqlSmartConnection.#wrap(rows);
      }
      const rows = await withQueryDeadline(
        params.length > 0
          ? this.#pool.unsafe<R>(compiledQuery.sql, params)
          : this.#pool.unsafe<R>(compiledQuery.sql),
      );
      return BunSqlSmartConnection.#wrap(rows);
    };

    /** Last-resort fallback after a prepared-statement failure: inline the
     *  params into the SQL and run via simple-query protocol (no prepare,
     *  no plan cache). Postgres' libpq-level escaping of literals is what
     *  we duplicate here — values are URL-safe primitives Kysely produced. */
    const runInline = async (): Promise<QueryResult<R>> => {
      const inlined = inlineParams(compiledQuery.sql, params);
      const rows = this.#reserved
        ? await this.#reserved.unsafe<R>(inlined)
        : await withQueryDeadline(this.#pool.unsafe<R>(inlined));
      return BunSqlSmartConnection.#wrap(rows);
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
      try {
        this.#reserved.release();
      } catch (err) {
        // Bun's pool can race idle-timeout against a transaction
        // release, leaving the connection in CLOSED state by the
        // time we get here. Swallow ERR_POSTGRES_CONNECTION_CLOSED
        // — there is nothing to release, the connection is already
        // gone. Any other error must surface so it can be fixed.
        const e = err as { code?: string; message?: string };
        const isClosed =
          e?.code === 'ERR_POSTGRES_CONNECTION_CLOSED' ||
          /Connection closed/i.test(e?.message ?? '');
        if (!isClosed) throw err;
      }
      this.#reserved = null;
    }
    // No-op for non-transaction connections — pool manages itself
  }
}
