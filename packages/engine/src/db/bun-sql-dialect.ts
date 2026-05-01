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
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  DialectAdapter,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryCompiler,
  QueryResult,
  TransactionSettings,
} from 'kysely';

// ─── Internal types for Bun.SQL (bun-types exposes via `Bun` global) ────

/** A reserved connection from Bun.SQL pool (bun >= 1.2) */
interface BunReservedConnection {
  /** Execute raw parameterized SQL — Bun.SQL's escape hatch for $1/$2 style */
  unsafe<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Release the connection back to the pool */
  release(): void;
}

/** Main Bun.SQL pool */
interface BunSQLPool {
  /** Execute raw parameterized SQL */
  unsafe<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  /** Reserve a dedicated connection from pool (for transactions) */
  reserve(): Promise<BunReservedConnection>;
  /** Register a handler for LISTEN/NOTIFY */
  subscribe(
    channel: string,
    handler: (payload: string) => void,
  ): Promise<BunSubscription>;
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
      throw new Error(
        '[BunSqlDialect] connectionString or DATABASE_URL is required',
      );
    }

    let cleanUrl = url.replace(/^(postgres(?:ql)?:\/\/[^@]*@)localhost([:/])/i, '$1127.0.0.1$2');
    let sslEnabled = false;
    try {
      const u = new URL(cleanUrl);
      const sslmode = u.searchParams.get('sslmode') ?? 'disable';
      sslEnabled = sslmode === 'require' || sslmode.startsWith('verify');
      u.search = '';
      cleanUrl = u.toString();
    } catch { /* URL parsing failed — use as-is */ }

    // @ts-expect-error — Bun.SQL not in standard Kysely types
    this.#pool = new Bun.SQL(cleanUrl, {
      max: this.#config.max ?? 20,
      idleTimeout: Math.ceil((this.#config.idleTimeoutMs ?? 30_000) / 1000),
      ...(sslEnabled ? {} : { ssl: false, tls: false }),
    }) as BunSQLPool;
    _activeBunPool = this.#pool;
  }

  /**
   * Returns a smart connection that uses pool.unsafe() directly for normal
   * queries (no reservation) and lazily reserves a connection only when a
   * transaction begins. This prevents pool exhaustion — reserve() pins a
   * dedicated backend connection; using it for every query drains max quickly.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#pool)
      throw new Error('[BunSqlDriver] Driver not initialized. Call initDatabase().');
    return new BunSqlSmartConnection(this.#pool);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    // Upgrade to reserved connection before sending BEGIN
    await (connection as BunSqlSmartConnection).reserveForTransaction();
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
    if (settings.isolationLevel) {
      await connection.executeQuery(
        CompiledQuery.raw(`SET TRANSACTION ISOLATION LEVEL ${settings.isolationLevel.toUpperCase()}`),
      );
    }
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as BunSqlSmartConnection).release();
  }

  async destroy(): Promise<void> {
    if (this.#pool) {
      await this.#pool.close();
      this.#pool = null;
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
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
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

  constructor(pool: BunSQLPool) {
    this.#pool = pool;
  }

  /** Called by beginTransaction() to pin a backend connection. */
  async reserveForTransaction(): Promise<void> {
    if (!this.#reserved) {
      this.#reserved = await this.#pool.reserve();
    }
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
        const rows = params.length > 0
          ? await this.#reserved.unsafe<R>(compiledQuery.sql, params)
          : await this.#reserved.unsafe<R>(compiledQuery.sql);
        return { rows };
      }
      const rows = params.length > 0
        ? await this.#pool.unsafe<R>(compiledQuery.sql, params)
        : await this.#pool.unsafe<R>(compiledQuery.sql);
      return { rows };
    };

    /** Last-resort fallback after a prepared-statement failure: inline the
     *  params into the SQL and run via simple-query protocol (no prepare,
     *  no plan cache). Postgres' libpq-level escaping of literals is what
     *  we duplicate here — values are URL-safe primitives Kysely produced. */
    const runInline = async (): Promise<QueryResult<R>> => {
      const inlined = inlineParams(compiledQuery.sql, params);
      const rows = this.#reserved
        ? await this.#reserved.unsafe<R>(inlined)
        : await this.#pool.unsafe<R>(inlined);
      return { rows };
    };

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
      const e = err as { code?: string; message?: string } | undefined;
      const isCachedPlan =
        e?.code === '0A000' || /cached plan must not change result type/i.test(e?.message ?? '');
      if (!isCachedPlan) throw err;

      try {
        return await runPrepared();
      } catch (err2) {
        const e2 = err2 as { code?: string; message?: string } | undefined;
        const stillCached =
          e2?.code === '0A000' || /cached plan must not change result type/i.test(e2?.message ?? '');
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

  release(): void {
    if (this.#reserved) {
      this.#reserved.release();
      this.#reserved = null;
    }
    // No-op for non-transaction connections — pool manages itself
  }
}
