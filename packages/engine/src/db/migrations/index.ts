import type { Database } from '../index.js';
import { readdir } from 'fs/promises';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function getMigrationNumber(filename: string): number {
  const match = filename.match(/^(\d+)/);
  if (!match) throw new Error(`Invalid migration filename: ${filename}`);
  return parseInt(match[1]);
}

/**
 * Parses the UP and DOWN sections of a migration file.
 * Convention: -- DOWN marker separates the two sections.
 */
export function parseMigrationFile(content: string): { up: string; down: string | null } {
  const downMarker = /^--\s*DOWN\s*$/im;
  const parts = content.split(downMarker);
  if (parts.length === 1) return { up: parts[0].trim(), down: null };
  return { up: parts[0].trim(), down: parts[1].trim() || null };
}

async function applyMigration(
  db: Database,
  migrationNumber: number,
  filename: string,
  fileContent: string,
): Promise<void> {
  const startTime = Date.now();
  const { up } = parseMigrationFile(fileContent);
  const checksum = createHash('sha256').update(up).digest('hex').slice(0, 16);

  // Check if already applied in zv_schema_versions
  const existing = await (db as any)
    .selectFrom('zv_schema_versions')
    .select(['version', 'checksum'])
    .where('version', '=', migrationNumber)
    .executeTakeFirst()
    .catch(() => null);

  if (existing) {
    if (existing.checksum !== checksum && existing.checksum !== 'baseline') {
      console.warn(
        `⚠️  Migration ${migrationNumber} checksum mismatch! ` +
        `File may have been modified after being applied.`,
      );
    }
    return; // Already applied
  }

  // Execute UP section — split into individual statements because Bun.SQL's
  // extended query protocol (used by unsafe()) does not allow multiple commands
  // in a single call. Each statement is executed separately.
  const statements = up
    .split(/;[ \t]*(?:--[^\n]*)?\n|;[ \t]*$/)
    .map((s: string) => s.trim())
    .filter((s: string) => {
      // Filter out empty statements, but keep statements that have actual SQL
      // even if they start with comment lines (strip comments before checking)
      const withoutComments = s.replace(/--[^\n]*/g, '').trim();
      return withoutComments.length > 0;
    });

  for (const stmt of statements) {
    await (db as any).executeQuery({ sql: stmt, parameters: [] });
  }

  const executionMs = Date.now() - startTime;
  const name = filename
    .replace(/^\d+_/, '')
    .replace('.sql', '')
    .replace(/_/g, ' ');

  // Record in zv_schema_versions
  await (db as any)
    .insertInto('zv_schema_versions')
    .values({
      version: migrationNumber,
      name,
      filename,
      checksum,
      engine_version: process.env.ZVELTIO_VERSION ?? '2.0.0',
      execution_ms: executionMs,
    })
    .execute()
    .catch(() => {}); // Non-fatal if tracking fails

  // Also record in legacy zv_migrations table for backward compat
  await (db as any)
    .insertInto('zv_migrations')
    .values({ name: filename.replace('.sql', '') })
    .execute()
    .catch(() => {});

  console.log(
    `   ✅ Migration ${String(migrationNumber).padStart(3, '0')} — ${name} (${executionMs}ms)`,
  );
}

export async function runPending(db: Database): Promise<void> {
  const migrationsDir = join(import.meta.dir, 'sql');
  if (!existsSync(migrationsDir)) {
    console.log('  No migrations directory found, skipping.');
    return;
  }

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const migrationNumber = getMigrationNumber(file);
    const fileContent = await Bun.file(join(migrationsDir, file)).text();
    await applyMigration(db, migrationNumber, file, fileContent);
  }
}

/** Alias for runPending — for use by CLI and external callers. */
export async function runMigrations(db: Database): Promise<void> {
  return runPending(db);
}

export async function getLastAppliedMigration(db: Database): Promise<number> {
  try {
    const result = await (db as any)
      .selectFrom('zv_schema_versions')
      .select('version')
      .where('rolled_back_at', 'is', null)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return result?.version ?? 0;
  } catch {
    return 0;
  }
}

export async function getAppliedMigrations(db: Database): Promise<Array<{
  version: number;
  name: string;
  filename: string;
  applied_at: Date;
  engine_version: string;
}>> {
  try {
    return await (db as any)
      .selectFrom('zv_schema_versions')
      .selectAll()
      .where('rolled_back_at', 'is', null)
      .orderBy('version', 'asc')
      .execute();
  } catch {
    return [];
  }
}

/**
 * Rolls back migrations from the current version down to targetVersion.
 * Requires -- DOWN sections in each migration file.
 */
export async function rollbackMigration(
  db: Database,
  targetVersion: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const migrationsDir = join(import.meta.dir, 'sql');

    const allFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => ({
        filename: f,
        version: parseInt(f.match(/^(\d+)/)?.[1] ?? '0'),
      }))
      .filter((f) => f.version > targetVersion)
      .sort((a, b) => b.version - a.version); // Descending for rollback

    if (allFiles.length === 0) {
      return { success: false, error: 'Nothing to rollback' };
    }

    for (const file of allFiles) {
      const content = readFileSync(join(migrationsDir, file.filename), 'utf-8');
      const { down } = parseMigrationFile(content);

      if (!down) {
        return {
          success: false,
          error:
            `Migration ${file.version} (${file.filename}) has no DOWN section. ` +
            `Manual rollback required.`,
        };
      }

      console.log(`   ⏪ Rolling back migration ${file.version}...`);
      await (db as any).executeQuery({ sql: down, parameters: [] });

      // Mark as rolled back
      await (db as any)
        .updateTable('zv_schema_versions')
        .set({ rolled_back_at: new Date() })
        .where('version', '=', file.version)
        .execute();

      console.log(`   ✅ Migration ${file.version} rolled back`);
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
