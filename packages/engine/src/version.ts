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

import { join } from 'path';
import { EMBEDDED_MIGRATIONS } from './db/migrations/embedded.js';
import pkg from '../package.json' with { type: 'json' };

// Read from package.json so a version bump is the single source of truth.
// `bun build` inlines this JSON into the compiled binary.
export const ENGINE_VERSION = pkg.version;

// Oldest migration version compatible with this engine.
// Change ONLY on MAJOR version bumps with breaking schema changes.
export const MIN_SCHEMA_VERSION = 0;

/** Computed from SQL files on disk (dev) or embedded migrations (compiled binary). */
export function getMaxSchemaVersion(): number {
  try {
    const migrationsDir = join(import.meta.dir, 'db', 'migrations', 'sql');
    // Bun.Glob is the native equivalent of readdirSync + filter — keeps
    // the lookup synchronous (required because MAX_SCHEMA_VERSION is a
    // module-level const evaluated at import time) without pulling in
    // node:fs. Falls through to EMBEDDED_MIGRATIONS in the compiled
    // binary, where the dir doesn't exist on disk.
    const glob = new Bun.Glob('*.sql');
    const versions: number[] = [];
    for (const f of glob.scanSync({ cwd: migrationsDir, onlyFiles: true })) {
      const m = f.match(/^(\d+)/);
      if (m) versions.push(parseInt(m[1], 10));
    }
    if (versions.length === 0) throw new Error('no migrations on disk');
    return Math.max(...versions);
  } catch {
    // Compiled binary: derive max version from embedded migrations
    const versions = Object.keys(EMBEDDED_MIGRATIONS).map((f) =>
      parseInt(f.match(/^(\d+)/)?.[1] ?? '0'),
    );
    return Math.max(...versions, 0);
  }
}

export const MAX_SCHEMA_VERSION = getMaxSchemaVersion();

/**
 * Verifies schema compatibility at engine startup.
 * Exits the process if the DB schema is incompatible with this engine version.
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export async function checkSchemaCompatibility(db: any): Promise<void> {
  const { migrationState } = await import('./db/migrations/index.js');
  const { lastApplied: currentVersion, pending } = await migrationState(db);

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

  // Counted by set, not `MAX - current`: a migration numbered below the head
  // (merged after a higher one) is pending while the head says up to date —
  // and with MIGRATIONS_AUTO=false this line is the only place that says so.
  if (pending.length > 0) {
    console.log(
      `⚠️  ${pending.length} pending migration(s): ${pending.map((m) => m.filename).join(', ')}. ` +
        'Run: zveltio migrate',
    );
  }
}

/**
 * Full version info object — used by health endpoints. Takes `migrationState`'s
 * answer: `pending` is the shipped files with no applied row, which a
 * high-water comparison cannot see when one sits below the head.
 */
export function getVersionInfo(state: { lastApplied: number; pending: readonly unknown[] }) {
  return {
    engine: ENGINE_VERSION,
    schema: {
      current: state.lastApplied,
      minimum: MIN_SCHEMA_VERSION,
      maximum: MAX_SCHEMA_VERSION,
      pending: state.pending.length,
      upToDate: state.pending.length === 0,
    },
    runtime: `Bun ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`,
    platform: `${process.platform}-${process.arch}`,
  };
}
