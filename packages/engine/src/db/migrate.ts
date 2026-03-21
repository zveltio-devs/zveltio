#!/usr/bin/env bun
/**
 * Standalone migration runner — used by CI and the CLI `zveltio migrate` command.
 * Usage: bun packages/engine/src/db/migrate.ts
 */

import { createDb } from './index.js';
import { runMigrations } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = createDb(databaseUrl);

try {
  await runMigrations(db);
  console.log('✅ Migrations complete');
  process.exit(0);
} catch (err) {
  console.error('❌ Migration failed:', err);
  process.exit(1);
}
