/**
 * Zveltio Engine Version and Schema Compatibility
 *
 * MIN_SCHEMA_VERSION: oldest schema compatible with this engine version
 * MAX_SCHEMA_VERSION: newest schema this engine version can run
 *
 * On engine update:
 *   - MAJOR bump → may change MIN_SCHEMA_VERSION
 *   - MINOR bump → increment MAX_SCHEMA_VERSION if new migrations added
 *   - PATCH bump → MAX_SCHEMA_VERSION unchanged
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import { EMBEDDED_MIGRATIONS } from './db/migrations/embedded.js';

export const ENGINE_VERSION = '2.0.0';

// Oldest migration version compatible with this engine.
// Change ONLY on MAJOR version bumps with breaking schema changes.
export const MIN_SCHEMA_VERSION = 0;

/** Computed from SQL files on disk (dev) or embedded migrations (compiled binary). */
export function getMaxSchemaVersion(): number {
  try {
    const migrationsDir = join(import.meta.dir, 'db', 'migrations', 'sql');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => parseInt(f.match(/^(\d+)/)?.[1] ?? '0'));
    return Math.max(...files, 0);
  } catch {
    // Compiled binary: derive max version from embedded migrations
    const versions = Object.keys(EMBEDDED_MIGRATIONS)
      .map((f) => parseInt(f.match(/^(\d+)/)?.[1] ?? '0'));
    return Math.max(...versions, 0);
  }
}

export const MAX_SCHEMA_VERSION = getMaxSchemaVersion();

/**
 * Verifies schema compatibility at engine startup.
 * Exits the process if the DB schema is incompatible with this engine version.
 */
export async function checkSchemaCompatibility(db: any): Promise<void> {
  const { getLastAppliedMigration } = await import('./db/migrations/index.js');
  const currentVersion = await getLastAppliedMigration(db);

  if (currentVersion < MIN_SCHEMA_VERSION) {
    console.error(`
❌ Database schema is too old!
   Current schema version:  ${currentVersion}
   Required minimum:        ${MIN_SCHEMA_VERSION}

   Run migrations to update:
   zveltio migrate
`);
    process.exit(1);
  }

  if (currentVersion > MAX_SCHEMA_VERSION) {
    console.error(`
❌ Database schema is newer than this engine version!
   Current schema version:  ${currentVersion}
   Maximum supported:       ${MAX_SCHEMA_VERSION}

   Update Zveltio to the latest version:
   zveltio update
`);
    process.exit(1);
  }

  const pendingCount = MAX_SCHEMA_VERSION - currentVersion;
  if (pendingCount > 0) {
    console.log(
      `⚠️  ${pendingCount} pending migration(s). Run: zveltio migrate`,
    );
  }
}

/** Full version info object — used by health endpoints. */
export function getVersionInfo(currentSchemaVersion: number) {
  return {
    engine: ENGINE_VERSION,
    schema: {
      current: currentSchemaVersion,
      minimum: MIN_SCHEMA_VERSION,
      maximum: MAX_SCHEMA_VERSION,
      pending: Math.max(0, MAX_SCHEMA_VERSION - currentSchemaVersion),
      upToDate: currentSchemaVersion >= MAX_SCHEMA_VERSION,
    },
    runtime: `Bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`,
    platform: `${process.platform}-${process.arch}`,
  };
}
