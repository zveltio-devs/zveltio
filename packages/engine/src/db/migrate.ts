#!/usr/bin/env bun
/**
 * Standalone migration runner — used by CI and the CLI `zveltio migrate` command.
 * Usage: bun packages/engine/src/db/migrate.ts
 */

import { sql } from 'kysely';
import { createDb } from './index.js';
import { runMigrations } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = createDb(databaseUrl);

// Force Kysely to initialize the driver before the migrations run.
//
// This used to say the driver had to be up "before runMigrations tries to use
// _activeBunPool". It does not: there is no reference to those module-level
// handles anywhere under db/migrations/, and since `primary` was added to the
// dialect a `createDb()` instance no longer sets them at all. What the probe
// still buys is a clear connection error here rather than one raised from
// inside the first migration.
await sql`SELECT 1`.execute(db);

try {
  await runMigrations(db);
  console.log('✅ Migrations complete');
  process.exit(0);
} catch (err) {
  console.error('❌ Migration failed:', err);
  process.exit(1);
}
