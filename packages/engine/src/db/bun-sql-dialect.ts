/**
 * BunSqlDialect — Kysely dialect nativ pentru Bun 1.2+ via Bun.SQL
 *
 * Avantaje față de `pg`:
 *  - I/O nativ Bun (fără libuv overhead)
 *  - Deserializare row nativă C++ (vs JS în pg)
 *  - Connection pool built-in cu reserve() pentru tranzacții corecte
 *  - Zero dependințe externe (Bun.SQL este built-in)
 *
 * Requires: Bun >= 1.2, bun-types în devDependencies
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

// ─── Tipuri interne pentru Bun.SQL (bun-types le expune via `Bun` global) ────

/** O conexiune rezervată din pool-ul Bun.SQL (bun >= 1.2) */
interface BunReservedConnection {
  /** Execută un query parametrizat $1/$2/... stil PostgreSQL */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Eliberează conexiunea înapoi în pool */
  release(): void;
}

/** Pool-ul principal Bun.SQL */
interface BunSQLPool {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Rezervă o conexiune dedicată din pool (pentru tranzacții) */
  reserve(): Promise<BunReservedConnection>;
  /** Înregistrează un handler pentru LISTEN/NOTIFY */
  subscribe(channel: string, handler: (payload: string) => void): Promise<BunSubscription>;
  /** Închide pool-ul și toate conexiunile */
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
   * Dimensiunea maximă a pool-ului de conexiuni.
   * @default 20
   */
  max?: number;
  /**
   * Timeout idle pentru conexiuni (ms).
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
    // Refolosim compilatorul PostgreSQL din Kysely — sintaxa $1/$2 e identică
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
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
      throw new Error('[BunSqlDialect] connectionString sau DATABASE_URL este obligatoriu');
    }

    // Bun.SQL creează automat un connection pool intern.
    // @ts-expect-error — Bun global tipat de bun-types, dar Bun.SQL nu e în tipurile standard Kysely
    this.#pool = new Bun.SQL(url, {
      max: this.#config.max ?? 20,
      idleTimeout: this.#config.idleTimeoutMs ?? 30_000,
    }) as BunSQLPool;
  }

  /**
   * Achizitionează o conexiune rezervată din pool.
   * reserve() pinuiește conexiunea la același socket TCP — necesar pentru
   * ca BEGIN/query.../COMMIT să ruleze pe același backend PostgreSQL.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#pool) throw new Error('[BunSqlDriver] Driver neinitialized. Apelați initDatabase().');
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
    // Eliberăm conexiunea rezervată înapoi în pool
    (connection as BunSqlConnection).release();
  }

  async destroy(): Promise<void> {
    if (this.#pool) {
      await this.#pool.close();
      this.#pool = null;
    }
  }

  /** Expune pool-ul pentru LISTEN/NOTIFY (folosit de RealtimeManager) */
  getPool(): BunSQLPool {
    if (!this.#pool) throw new Error('[BunSqlDriver] Pool neinitialized.');
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
    const rows = await this.#conn.query<R>(
      compiledQuery.sql,
      compiledQuery.parameters as unknown[],
    );
    return { rows };
  }

  // Streaming nu este suportat de Bun.SQL încă (Bun 1.2)
  async *streamQuery<R>(
    _compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('[BunSqlConnection] streamQuery nu este suportat în BunSqlDialect');
  }

  release(): void {
    this.#conn.release();
  }
}
