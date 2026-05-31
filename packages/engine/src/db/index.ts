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

let _db: Database | null = null;

export async function initDatabase(): Promise<Database> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

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
  _db = new Kysely({
    dialect: new BunSqlDialect({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 10), // PgDog handles real pooling; 10 is sufficient
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
