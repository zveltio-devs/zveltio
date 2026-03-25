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

    // Normalize URL: replace "localhost" with "127.0.0.1" to force IPv4
    // (some systems resolve localhost → ::1 which may not be bound by Docker).
    // Strip query params (e.g. ?sslmode=disable) — Bun.SQL doesn't reliably
    // parse them; pass ssl option explicitly instead.
    let cleanUrl = url.replace(/^(postgres(?:ql)?:\/\/[^@]*@)localhost([:/])/i, '$1127.0.0.1$2');
    let sslDisabled = false;
    try {
      const u = new URL(cleanUrl);
      if (u.searchParams.get('sslmode') === 'disable') sslDisabled = true;
      u.search = '';
      cleanUrl = u.toString();
    } catch {
      // URL parsing failed — use as-is, assume no SSL
      sslDisabled = true;
    }

    // Bun.SQL creează automat un connection pool intern.
    // NOTE: Bun.SQL idleTimeout is in SECONDS (not ms). Convert from ms config.
    // @ts-expect-error — Bun global tipat de bun-types, dar Bun.SQL nu e în tipurile standard Kysely
    this.#pool = new Bun.SQL(cleanUrl, {
      max: this.#config.max ?? 20,
      idleTimeout: Math.ceil((this.#config.idleTimeoutMs ?? 30_000) / 1000),
      ...(sslDisabled ? { ssl: false } : {}),
    }) as BunSQLPool;
    _activeBunPool = this.#pool;
  }

  /**
   * Achizitionează o conexiune rezervată din pool.
   * reserve() pinuiește conexiunea la același socket TCP — necesar pentru
   * ca BEGIN/query.../COMMIT să ruleze pe același backend PostgreSQL.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#pool)
      throw new Error(
        '[BunSqlDriver] Driver neinitialized. Apelați initDatabase().',
      );
    const reserved = await this.#pool.reserve();
    return new BunSqlConnection(reserved);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
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
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    // Release the reserved connection back to the pool
    (connection as BunSqlConnection).release();
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

// ─── Connection ──────────────────────────────────────────────────────────────

class BunSqlConnection implements DatabaseConnection {
  readonly #conn: BunReservedConnection;

  constructor(conn: BunReservedConnection) {
    this.#conn = conn;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    // Bun.SQL's unsafe() does not serialize JS arrays as PostgreSQL array
    // literals — it calls .toString() which produces e.g. 'insert' for
    // ['insert'], causing "malformed array literal" errors on text[] columns.
    // Convert any array parameter to the PostgreSQL literal format {val,...}.
    const params = (compiledQuery.parameters as unknown[]).map((p) => {
      if (!Array.isArray(p)) return p;
      const escaped = (p as unknown[]).map((item) => {
        if (item === null || item === undefined) return 'NULL';
        const s = String(item);
        // Escape backslashes and double-quotes, then wrap in double-quotes
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      });
      return `{${escaped.join(',')}}`;
    });
    // Bun.SQL: passing an empty array activates prepared-statement mode,
    // which forbids multiple commands (e.g. migration files).
    // Omit params entirely when there are none → simple-query mode.
    const rows = params.length > 0
      ? await this.#conn.unsafe<R>(compiledQuery.sql, params)
      : await this.#conn.unsafe<R>(compiledQuery.sql);
    return { rows };
  }

  // Streaming is not supported by Bun.SQL yet (Bun 1.2)
  // eslint-disable-next-line require-yield
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      '[BunSqlConnection] streamQuery is not supported in BunSqlDialect',
    );
  }

  release(): void {
    this.#conn.release();
  }
}
