import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from './bun-sql-dialect.js';
import type { DbSchema } from './schema.js';

export type Database = Kysely<DbSchema>;

/**
 * Creates a standalone Kysely instance for a given connection string.
 * Used primarily in integration tests to get an isolated db connection.
 */
export function createDb(connectionString: string): Database {
  return new Kysely({
    dialect: new BunSqlDialect({ connectionString }),
  });
}

/**
 * Ask Postgres to end a transaction nobody is going to finish.
 *
 * Bun's server abandons a handler after its idle timeout, and if that happens
 * while a tenant transaction is open the connection is neither committed nor
 * rolled back: it leaves the pool and never comes back. The pool holds ten
 * connections, so the loss compounds — fewer connections make more requests
 * slow, and more slowness abandons more handlers. Measured under load: nine of
 * ten gone, no recovery after a minute of total silence, and the process still
 * listening, so a TCP healthcheck reports a healthy instance.
 *
 * Set on the CONNECTION, not per transaction. The obvious version — a
 * `SET LOCAL` beside the tenant GUC — was written first and does not work: the
 * abandonment happens between `BEGIN` and the first statement, so the timeout
 * is never installed on exactly the transactions that need it. Verified by
 * reproducing the leak with it in place; seven connections stayed stuck.
 *
 * Sixty seconds by default, deliberately far above any legitimate request. This
 * must never fire on a query that is merely slow — a report over a large
 * collection can take tens of seconds, and killing one would trade a leak for a
 * wrong answer. It fires only when nothing is left to finish the transaction.
 *
 * An operator who already sets the option in DATABASE_URL keeps theirs;
 * `DB_IDLE_IN_TXN_TIMEOUT_MS=0` disables it entirely.
 */
export function withIdleInTransactionTimeout(url: string): string {
  const ms = Number(process.env.DB_IDLE_IN_TXN_TIMEOUT_MS ?? 60_000);
  if (!Number.isFinite(ms) || ms <= 0) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can safely rewrite (a libpq keyword string, say). Leaving it
    // alone is right: a mangled connection string is worse than a leak.
    return url;
  }

  const existing = parsed.searchParams.get('options') ?? '';
  if (existing.includes('idle_in_transaction_session_timeout')) return url;

  const option = `-c idle_in_transaction_session_timeout=${Math.floor(ms)}`;
  parsed.searchParams.set('options', existing ? `${existing} ${option}` : option);
  return parsed.toString();
}

let _db: Database | null = null;

export async function initDatabase(): Promise<Database> {
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const databaseUrl = withIdleInTransactionTimeout(rawDatabaseUrl);

  // Idle timeout default raised to 5min in alpha.128 to close the
  // Bun.SQL transaction race during studio rebuild (`bun run build`
  // can hold 5–15s of subprocess work, the previous 30s window made
  // it likely the connection got evicted mid-transaction and the C++
  // binding threw `connection must be a PostgresSQLConnection`).
  // BUN_SQL_IDLE_TIMEOUT_MS is the documented knob in the dialect;
  // DB_IDLE_TIMEOUT_MS stays accepted for backward compat with
  // operators who already set it. Either env var wins over the
  // default; if both are set, BUN_SQL_IDLE_TIMEOUT_MS wins because
  // it's the one documented in EXTENSION-DEVELOPER-GUIDE.
  const idleEnv = process.env.BUN_SQL_IDLE_TIMEOUT_MS ?? process.env.DB_IDLE_TIMEOUT_MS;
  const poolMax = Number(process.env.DB_POOL_MAX ?? 10);
  _db = new Kysely({
    dialect: new BunSqlDialect({
      connectionString: databaseUrl,
      // Not a throughput knob — a ceiling on concurrent requests.
      //
      // Every `/api/*` request outside TXN_SKIP_PREFIXES pins one connection for
      // its whole life, because that is how the tenant transaction enforces RLS.
      // Several routes then query the pool AGAIN while holding it, so a request
      // can want two. Ten was below what the admin dashboard asks for on a
      // single load: it fires fourteen requests, and measured against a cold
      // engine the first bursts took 10.6s, 12.0s and 12.0s before settling to
      // ~70ms. Twelve seconds is Bun.serve abandoning the handler at its 10s
      // idleTimeout, which leaves the tenant transaction open and the connection
      // leaked — see `withIdleInTransactionTimeout`, which mitigates the leak
      // from the Postgres side.
      //
      // The second checkout is gone: `createRequestScopedDb` hands core routes a
      // proxy that resolves the current tenant transaction through
      // AsyncLocalStorage and only reaches for the pool when there is none, so a
      // request pins one connection rather than two. The routes that genuinely
      // must escape RLS — tenant provisioning, invitation accept, the SQL editor,
      // backup, saved queries — take `poolDb` explicitly and are the only ones
      // that do.
      //
      // Ten was briefly raised to 25 while that defect stood. It is back down,
      // because a ceiling sized around a bug outlives the bug and then quietly
      // becomes a connection budget nobody agreed to: CI runs several engines
      // against one Postgres and 25 apiece exhausted it, which is exactly what a
      // multi-replica deployment would hit. With one connection per request the
      // same dashboard burst settles at ~425ms; 25 buys ~76ms, which is a real
      // gain and the reason this is an env var rather than a constant. Raise it
      // deliberately, against a `max_connections` you have checked.
      max: poolMax,
      idleTimeoutMs: idleEnv ? Number(idleEnv) : 300_000,
    }),
  });

  // Test connection with retry — PgDog/pooler may need up to ~60s to initialize its backend pool
  const maxAttempts = 20;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`SELECT 1`.execute(_db);
      break;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const wait = Math.min(1000 * attempt, 5000);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `⏳ Database not ready (attempt ${attempt}/${maxAttempts}), retrying in ${wait / 1000}s... [${msg}]`,
      );
      await Bun.sleep(wait);
    }
  }

  // Run core migrations
  await runCoreMigrations(_db);

  return _db;
}

export function getDb(): Database {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.');
  return _db;
}

async function runCoreMigrations(db: Database): Promise<void> {
  // Create migrations tracking table
  await db.schema
    .createTable('zv_migrations')
    .ifNotExists()
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('ran_at', 'timestamptz', (col) => col.notNull().defaultTo(new Date()))
    .execute();

  // Core migrations list
  const migrations = await import('./migrations/index.js');
  await migrations.runPending(db);
}
