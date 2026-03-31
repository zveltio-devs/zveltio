import type { Database } from '../index.js';
import { readdir } from 'fs/promises';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { EMBEDDED_MIGRATIONS } from './embedded.js';

/**
 * Splits a SQL string into individual statements on top-level semicolons.
 * Correctly handles:
 *  - Single-quoted strings  'it''s fine'
 *  - Double-quoted identifiers  "col name"
 *  - Dollar-quoted bodies  $$ ... $$ / $tag$ ... $tag$
 *  - Line comments  -- ...
 *  - Block comments  /* ... * /
 *  - Nested parentheses  (VALUES (...), (...))
 */
export function splitSqlStatements(sql: string): string[] {
  const results: string[] = [];
  let current = '';
  let i = 0;
  const len = sql.length;

  // State
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | null = null; // e.g. '$$' or '$body$'
  let parenDepth = 0;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // ── Line comment ──────────────────────────────────────────────
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }

    // ── Block comment ─────────────────────────────────────────────
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 2;
        inBlockComment = false;
      } else {
        i++;
      }
      continue;
    }

    // ── Dollar-quoted string ──────────────────────────────────────
    if (dollarTag !== null) {
      current += ch;
      if (sql.startsWith(dollarTag, i)) {
        current += sql.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
      } else {
        i++;
      }
      continue;
    }

    // ── Single-quoted string ──────────────────────────────────────
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") { // escaped quote
        current += next;
        i += 2;
      } else if (ch === "'") {
        inSingleQuote = false;
        i++;
      } else {
        i++;
      }
      continue;
    }

    // ── Double-quoted identifier ──────────────────────────────────
    if (inDoubleQuote) {
      current += ch;
      if (ch === '"' && next === '"') { // escaped quote
        current += next;
        i += 2;
      } else if (ch === '"') {
        inDoubleQuote = false;
        i++;
      } else {
        i++;
      }
      continue;
    }

    // ── Normal context — detect start of special regions ──────────

    // Line comment
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      i++;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      i++;
      continue;
    }

    // Single quote
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i++;
      continue;
    }

    // Double quote
    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i++;
      continue;
    }

    // Dollar quote — scan for closing $...$
    if (ch === '$') {
      const end = sql.indexOf('$', i + 1);
      if (end !== -1) {
        const tag = sql.slice(i, end + 1); // e.g. '$$' or '$body$'
        // Only treat as dollar-quote if tag contains no whitespace
        if (!/\s/.test(tag)) {
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
      }
    }

    // Parentheses
    if (ch === '(') { parenDepth++; current += ch; i++; continue; }
    if (ch === ')') { parenDepth--; current += ch; i++; continue; }

    // Semicolon — statement boundary only at top level
    if (ch === ';' && parenDepth === 0) {
      const stmt = current.trim();
      if (stmt.length > 0) results.push(stmt);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Trailing statement without semicolon
  const trailing = current.trim();
  if (trailing.length > 0) results.push(trailing);

  return results;
}

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

  // Run all statements inside a single Kysely transaction so they share one
  // reserved backend connection with an explicit BEGIN/COMMIT. PostgreSQL
  // supports transactional DDL — if any statement fails the whole migration
  // rolls back cleanly. BunSqlSmartConnection.reserveForTransaction() is called
  // by beginTransaction() to pin the connection for the duration.
  const statements = splitSqlStatements(up);

  await (db as any).transaction().execute(async (trx: any) => {
    for (let si = 0; si < statements.length; si++) {
      const stmt = statements[si];
      try {
        await trx.executeQuery({ sql: stmt, parameters: [] });
      } catch (err: any) {
        throw Object.assign(
          new Error(
            `Migration ${migrationNumber} statement ${si + 1}/${statements.length} failed:\n` +
            `${stmt.slice(0, 300)}\n\nCause: ${err.message}`,
          ),
          { cause: err },
        );
      }
    }
  });

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

  let files: string[];
  let getContent: (file: string) => Promise<string>;

  if (existsSync(migrationsDir)) {
    // Development / source mode: read from filesystem
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    getContent = (file) => Bun.file(join(migrationsDir, file)).text();
  } else {
    // Compiled binary mode: use embedded migrations bundled at build time
    files = Object.keys(EMBEDDED_MIGRATIONS).sort();
    getContent = (file) => Promise.resolve(EMBEDDED_MIGRATIONS[file]);
  }

  for (const file of files) {
    const migrationNumber = getMigrationNumber(file);
    const fileContent = await getContent(file);
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
      await (db as any).transaction().execute(async (trx: any) => {
        for (const stmt of splitSqlStatements(down)) {
          await trx.executeQuery({ sql: stmt, parameters: [] });
        }
      });

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
