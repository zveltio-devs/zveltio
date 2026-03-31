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

    if (this.#reserved) {
      // Transaction mode — use pinned reserved connection
      const rows = params.length > 0
        ? await this.#reserved.unsafe<R>(compiledQuery.sql, params)
        : await this.#reserved.unsafe<R>(compiledQuery.sql);
      return { rows };
    }

    // Normal mode — use pool directly, no reservation needed
    const rows = params.length > 0
      ? await this.#pool.unsafe<R>(compiledQuery.sql, params)
      : await this.#pool.unsafe<R>(compiledQuery.sql);
    return { rows };
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
