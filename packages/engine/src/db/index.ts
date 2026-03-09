import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from './bun-sql-dialect.js';

export type Database = Kysely<any>;

let _db: Database | null = null;

export async function initDatabase(): Promise<Database> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  _db = new Kysely({
    dialect: new BunSqlDialect({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMs: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
    }),
  });

  // Test connection — selectăm o constantă fără acces la tabele utilizator
  await sql`SELECT 1`.execute(_db);

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
