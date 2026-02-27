import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export type Database = Kysely<any>;

let _db: Database | null = null;

export async function initDatabase(): Promise<Database> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  // Test connection
  await pool.query('SELECT 1');

  _db = new Kysely({
    dialect: new PostgresDialect({ pool }),
  });

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
