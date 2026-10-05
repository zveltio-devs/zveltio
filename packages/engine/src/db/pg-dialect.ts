/**
 * A second Kysely dialect over node-postgres (`pg`), selected with
 * `ZVELTIO_DB_DRIVER=pg`. Bun stays the runtime; this hedges the DRIVER.
 *
 * `Bun.SQL` is young, and the engine carries workarounds for it (a C++ throw
 * that escapes `await`, `connection must be a PostgresSQLConnection`, plans
 * that go stale after an ALTER). `pg` is already installed — pg-boss runs on it
 * — and runs on Bun, so an operator who meets a driver defect can switch
 * without waiting for upstream, and CI runs the harness on both.
 *
 * Switching must not change what lands in the database, so this answers like
 * `BunSqlDialect` wherever a caller or a stored byte could tell them apart:
 *
 *   - **Parameters bound to `json`/`jsonb` are JSON-encoded.** `Bun.SQL` reads
 *     the parameter types the server describes and encodes such a value as
 *     JSON — a string becomes a JSON string. `pg` sends a string as it is, so
 *     the same statement stored a different value, or failed to parse it. The
 *     types are asked once per statement text (`PREPARE`, then
 *     `pg_prepared_statements`), cached, and only for statements that bind a
 *     string or an object.
 *   - **Arrays are bound as `BunSqlDialect` binds them**: a Postgres array
 *     literal, built the same way.
 *   - **A failed statement carries its SQLSTATE on `errno`**, as `Bun.SQL`
 *     reports it; the engine reads `errno` first.
 *   - **Waiting for a connection is bounded** (`DB_ACQUIRE_TIMEOUT_MS`) and
 *     answers `PoolBusyError`.
 *   - **The primary database registers a raw pool** for the worker-extension
 *     SQL bridge, which reserves a connection and runs `unsafe(sql, params)`.
 *
 * No plan recycling is needed: `pg` sends unnamed statements, so there is no
 * client-side plan cache to go stale after a migration. The parameter-type
 * cache is cleared on the same signal (`recycleActivePool`).
 */
import pg from 'pg';
import {
  CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import { PoolBusyError, type RawPool, registerActivePool } from './bun-sql-dialect.js';

export interface PgDialectConfig {
  connectionString: string;
  primary?: boolean;
  max?: number;
  idleTimeoutMs?: number;
}

const ACQUIRE_TIMEOUT_MS = Number(process.env.DB_ACQUIRE_TIMEOUT_MS ?? 5_000);

/** Which driver the engine's pool runs on: `bun` (default) or `pg`. */
export function databaseDriver(): 'bun' | 'pg' {
  const v = (process.env.ZVELTIO_DB_DRIVER ?? 'bun').trim().toLowerCase();
  if (v === 'bun' || v === '') return 'bun';
  if (v === 'pg') return 'pg';
  throw new Error(`ZVELTIO_DB_DRIVER must be "bun" or "pg", not "${v}"`);
}

/** SQLSTATE on `errno` as well as `code`, the way `Bun.SQL` reports it. */
export function normalizePgError(err: unknown): unknown {
  const e = err as { code?: unknown; errno?: unknown } | null;
  if (e && typeof e === 'object' && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    if (e.errno === undefined) e.errno = e.code;
  }
  if (e instanceof Error && /timeout exceeded when trying to connect/i.test(e.message)) {
    return new PoolBusyError(ACQUIRE_TIMEOUT_MS);
  }
  return err;
}

/** An array parameter as `BunSqlDialect` binds it: a Postgres array literal. */
function arrayLiteral(p: unknown[]): string {
  const items = p.map((item) => {
    if (item === null || item === undefined) return 'NULL';
    const s = String(item);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

/** Whether binding `v` can depend on the parameter's declared type. */
const typeSensitive = (v: unknown) =>
  typeof v === 'string' || (v !== null && typeof v === 'object');

const TYPE_CACHE_MAX = 5_000;
const paramTypeCache = new Map<string, readonly string[]>();
let prepareSeq = 0;

/** Drop the cached parameter types, e.g. after migrations altered columns. */
export function clearPgParamTypeCache(): void {
  paramTypeCache.clear();
}

async function paramTypes(client: pg.PoolClient, text: string): Promise<readonly string[]> {
  const hit = paramTypeCache.get(text);
  if (hit) return hit;
  const name = `zv_param_types_${++prepareSeq}`;
  // One round trip: the simple protocol runs the three in order. A statement
  // that cannot be prepared cannot be executed either, so its error is the
  // statement's own and is thrown as such.
  const res = (await client.query(
    `PREPARE ${name} AS ${text}; ` +
      `SELECT parameter_types::text[] AS t FROM pg_prepared_statements WHERE name = '${name}'; ` +
      `DEALLOCATE ${name}`,
  )) as unknown as pg.QueryResult[];
  const types = ((res[1]?.rows[0] as { t?: string[] } | undefined)?.t ?? []) as string[];
  if (paramTypeCache.size >= TYPE_CACHE_MAX) {
    const oldest = paramTypeCache.keys().next().value;
    if (oldest !== undefined) paramTypeCache.delete(oldest);
  }
  paramTypeCache.set(text, types);
  return types;
}

/** The parameters as `Bun.SQL` would send them for this statement. */
async function bindLikeBun(
  client: pg.PoolClient,
  text: string,
  params: readonly unknown[],
): Promise<unknown[]> {
  const out = params.map((p) => (Array.isArray(p) ? arrayLiteral(p) : p));
  if (!params.some(typeSensitive)) return out;
  const types = await paramTypes(client, text);
  return out.map((v, i) => {
    const t = types[i];
    if ((t === 'json' || t === 'jsonb') && v !== null && v !== undefined) {
      return JSON.stringify(v);
    }
    return v;
  });
}

async function run(
  client: pg.PoolClient,
  text: string,
  params: readonly unknown[],
): Promise<pg.QueryResult> {
  try {
    if (params.length === 0) return await client.query(text);
    return await client.query(text, await bindLikeBun(client, text, params));
  } catch (err) {
    throw normalizePgError(err);
  }
}

class PgConnection implements DatabaseConnection {
  constructor(readonly client: pg.PoolClient) {}

  async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
    const r = await run(this.client, q.sql, q.parameters);
    // A multi-statement simple query answers one result per statement.
    const last = (Array.isArray(r) ? r[r.length - 1] : r) as pg.QueryResult | undefined;
    const counted = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(last?.command ?? '');
    return {
      rows: (last?.rows ?? []) as R[],
      ...(counted && last?.rowCount != null ? { numAffectedRows: BigInt(last.rowCount) } : {}),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('[PgConnection] streamQuery is not supported');
  }
}

class PgDriver implements Driver {
  constructor(
    readonly pool: pg.Pool,
    readonly primary: boolean,
  ) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    try {
      return new PgConnection(await this.pool.connect());
    } catch (err) {
      throw normalizePgError(err);
    }
  }

  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    let text = 'BEGIN';
    if (settings.isolationLevel || settings.accessMode) {
      text = 'START TRANSACTION';
      if (settings.isolationLevel) text += ` ISOLATION LEVEL ${settings.isolationLevel}`;
      if (settings.accessMode) text += ` ${settings.accessMode}`;
    }
    await conn.executeQuery(CompiledQuery.raw(text));
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async releaseConnection(conn: DatabaseConnection): Promise<void> {
    (conn as PgConnection).client.release();
  }

  async destroy(): Promise<void> {
    if (this.primary) registerActivePool(null);
    await this.pool.end();
  }
}

/** The worker bridge's view of a `pg` pool. */
function rawPool(pool: pg.Pool): RawPool {
  const rows = <T>(r: pg.QueryResult): T[] => {
    const last = (Array.isArray(r) ? r[r.length - 1] : r) as pg.QueryResult | undefined;
    return (last?.rows ?? []) as T[];
  };
  const once = async <T>(text: string, params?: unknown[]): Promise<T[]> => {
    const client = await pool.connect().catch((err) => {
      throw normalizePgError(err);
    });
    try {
      return rows<T>(await run(client, text, params ?? []));
    } finally {
      client.release();
    }
  };
  return {
    unsafe: once,
    reserve: async () => {
      const client = await pool.connect().catch((err) => {
        throw normalizePgError(err);
      });
      return {
        unsafe: async <T>(text: string, params?: unknown[]) =>
          rows<T>(await run(client, text, params ?? [])),
        release: () => client.release(),
      };
    },
    recycle: async () => clearPgParamTypeCache(),
  };
}

export function createPgDialect(config: PgDialectConfig): Dialect {
  // `localhost` resolves to ::1 first on some hosts, where Postgres in a
  // container listens on IPv4 only — the rewrite `BunSqlDialect` makes too.
  const connectionString = config.connectionString.replace(
    /^(postgres(?:ql)?:\/\/[^@]*@)localhost([:/])/i,
    '$1127.0.0.1$2',
  );
  const pool = new pg.Pool({
    connectionString,
    max: config.max ?? 20,
    idleTimeoutMillis: config.idleTimeoutMs ?? 300_000,
    connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
  });
  // A client whose backend dies (terminated, idle-in-transaction timeout) emits
  // `error`. With no listener, a checked-out client's event is thrown out of
  // the socket handler instead of failing the query that waits on it.
  pool.on('error', (err) => {
    console.warn('[pg] idle client error:', err.message);
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      console.warn('[pg] client error:', err.message);
    });
  });
  if (config.primary) registerActivePool(rawPool(pool));
  return {
    createAdapter: () => new PostgresAdapter(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
    createDriver: () => new PgDriver(pool, config.primary === true),
  };
}
