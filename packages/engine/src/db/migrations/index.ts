import type { Database } from '../index.js';
import { join } from 'path';
import { createHash } from 'crypto';
import { EMBEDDED_MIGRATIONS } from './embedded.js';
import { ENGINE_VERSION } from '../../version.js';

// Small Bun-native helpers used in place of node:fs — matches the
// project rule "Bun.file, Bun.spawn — NOT fs/child_process".
async function dirExists(path: string): Promise<boolean> {
  try {
    // Bun.file().stat() works on any path; isDirectory tells us if the
    // entry is a directory (vs a missing path which throws).
    const stat = await Bun.file(path).stat();
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function listSqlFilesSync(dir: string): string[] {
  const glob = new Bun.Glob('*.sql');
  return [...glob.scanSync({ cwd: dir, onlyFiles: true })];
}

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
      if (ch === "'" && next === "'") {
        // escaped quote
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
      if (ch === '"' && next === '"') {
        // escaped quote
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
    if (ch === '(') {
      parenDepth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      parenDepth--;
      current += ch;
      i++;
      continue;
    }

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

/**
 * A migration may opt out of the transaction wrapper with a `-- NO TRANSACTION`
 * line, in the same spelling style as `-- DOWN`.
 *
 * The reason it exists: `CREATE INDEX CONCURRENTLY` is illegal inside a
 * transaction block. Without an escape hatch every index this engine creates
 * takes a lock that blocks writes for the length of the build — imperceptible
 * on a small table, an outage on `zv_audit_log` at a customer who has been
 * running for two years.
 *
 * The cost is real and is why this is opt-in rather than the default: without
 * a transaction, a migration that fails halfway leaves the half behind. Nothing
 * rolls back. The version row is only written after every statement succeeds,
 * so a failed run is retried on next boot — which means the statements have to
 * survive being run twice. Use `IF NOT EXISTS` throughout; the migration linter
 * enforces exactly that for files carrying this marker, and stops asking for
 * `CONCURRENTLY` to be avoided.
 *
 * One trap worth knowing: a `CREATE INDEX CONCURRENTLY` that fails leaves an
 * INVALID index behind, and `IF NOT EXISTS` will then happily skip re-creating
 * it. Precede it with `DROP INDEX IF EXISTS` so a retry starts clean.
 */
export function isNonTransactional(up: string): boolean {
  return /^--\s*NO\s+TRANSACTION\s*$/im.test(up);
}

/**
 * Postgres interval literals accepted for the two timeouts below. These values
 * reach SQL through string interpolation — `SET` does not take parameters — so
 * the shape is checked rather than trusted. An operator who fat-fingers the
 * env var gets a startup error, not a statement built from their typo.
 */
const TIMEOUT_PATTERN = /^\d+(ms|s|min)?$/;

/**
 * Turn the two timeout cancellations into something an operator can act on.
 *
 * Both arrive as "canceling statement due to ..." with no hint that a setting
 * this engine chose is responsible, and an upgrade that stops the instance from
 * booting is the worst moment to be handed a bare Postgres string. The advice
 * matters most for the operator who did not set anything and has no idea why
 * their migration was cancelled.
 *
 * SQLSTATE lives on `errno` under Bun's SQL driver — `code` is the generic
 * `ERR_POSTGRES_SERVER_ERROR` for every server-side failure, so reading it
 * would match nothing. Verified against both cancellations.
 */
export function timeoutAdvice(err: unknown): string | null {
  const sqlstate = (err as { errno?: unknown } | null)?.errno;

  if (sqlstate === '55P03') {
    const configured = process.env.ZVELTIO_MIGRATION_LOCK_TIMEOUT || '5s';
    return (
      `\nThis is a lock timeout, not a fault in the migration: it waited ${configured} ` +
      `for a lock on the table and something else was holding one.\n` +
      `Nothing was applied — the migration rolled back and will be retried on the next boot.\n` +
      `Find the holder with:\n` +
      `  SELECT pid, state, wait_event_type, left(query, 120) FROM pg_stat_activity\n` +
      `   WHERE state <> 'idle' ORDER BY query_start;\n` +
      `Waiting longer is the wrong instinct on a live instance — an ALTER queued for a lock ` +
      `blocks every read arriving behind it. Let the other query finish, or raise\n` +
      `ZVELTIO_MIGRATION_LOCK_TIMEOUT during a maintenance window when nothing else is running.`
    );
  }

  if (sqlstate === '57014') {
    const configured = process.env.ZVELTIO_MIGRATION_STATEMENT_TIMEOUT;
    return (
      `\nThe statement itself ran too long and was cancelled by a statement timeout.\n` +
      (configured
        ? `ZVELTIO_MIGRATION_STATEMENT_TIMEOUT is set to "${configured}". Raise it, or clear it ` +
          `for this upgrade — it is unset by default precisely because a large but legitimate ` +
          `backfill would otherwise leave an upgrade that can never finish.`
        : `ZVELTIO_MIGRATION_STATEMENT_TIMEOUT is not set here, so the limit comes from the ` +
          `server or the role — check \`SHOW statement_timeout\` and any ALTER ROLE ... SET. ` +
          `Migrations need to outlast ordinary queries; a global limit tuned for application ` +
          `traffic will cut a backfill short.`) +
      `\nNothing was applied — the migration rolled back and will be retried on the next boot.`
    );
  }

  return null;
}

/**
 * The one method a migration statement needs, present on both a Kysely instance
 * and a transaction — which is the whole point, since the same statement runs
 * on either depending on whether the migration opted out of the wrapper.
 *
 * Spelled out structurally rather than reaching for Kysely's own signature:
 * what actually travels is `{ sql, parameters }`, and `BunSqlDialect` reads
 * nothing else. Naming that shape says what the code depends on, where an
 * `any` would only have said nobody checked.
 */
interface StatementExecutor {
  executeQuery(query: { sql: string; parameters: readonly unknown[] }): Promise<unknown>;
}

export function timeoutSetting(envVar: string, fallback: string): string {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return fallback;
  if (!TIMEOUT_PATTERN.test(raw)) {
    throw new Error(
      `${envVar}="${raw}" is not a Postgres interval literal. ` +
        `Use a number with an optional unit, e.g. "5s", "250ms", "2min".`,
    );
  }
  return raw;
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

  // Has this migration already been applied?
  //
  // The read used to end `.catch(() => null)`, and `null` here means "not applied
  // yet — run it". So any failure to answer the question re-ran the migration.
  // The tracking write further down says what that costs, in its own words: "a
  // chronic failure means the next run will re-apply the same migration, which
  // can break idempotence." `CREATE TABLE IF NOT EXISTS` survives that; a seed
  // INSERT, a backfill UPDATE, or an ADD COLUMN without IF NOT EXISTS does not.
  //
  // One failure IS expected and is not a failure at all: `zv_schema_versions` is
  // created by `001_initial.sql`, so before the first migration runs the table
  // genuinely does not exist. That is 42P01, and it means "nothing has been
  // applied", which is true. Every other error means the answer is unknown.
  let existing: { version: number; checksum: string } | undefined;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    existing = await (db as any)
      .selectFrom('zv_schema_versions')
      .select(['version', 'checksum'])
      .where('version', '=', migrationNumber)
      .executeTakeFirst();
  } catch (err) {
    const code =
      (err as { errno?: string; code?: string }).errno ?? (err as { code?: string }).code ?? '';
    if (code !== '42P01') throw err;
  }

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
  const nonTransactional = isNonTransactional(up);

  const runStatements = async (exec: StatementExecutor, si: number): Promise<void> => {
    const stmt = statements[si];
    try {
      await exec.executeQuery({ sql: stmt, parameters: [] });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      throw Object.assign(
        new Error(
          `Migration ${migrationNumber} statement ${si + 1}/${statements.length} failed:\n` +
            `${stmt.slice(0, 300)}\n\nCause: ${err.message}${timeoutAdvice(err) ?? ''}`,
        ),
        { cause: err },
      );
    }
  };

  if (nonTransactional) {
    // No wrapper, and deliberately no timeouts either. This path exists for
    // `CREATE INDEX CONCURRENTLY`, which waits on in-flight transactions by
    // design and can legitimately run for a long time on a large table — the
    // two settings below would abort exactly the work this path is for.
    //
    // `SET LOCAL` would be meaningless here anyway (no transaction to be local
    // to), and a session-level `SET` on a pooled connection outlives the
    // migration and leaks into whoever gets that connection next.
    console.log(`[migrations] ${filename}: running without a transaction (-- NO TRANSACTION)`);
    for (let si = 0; si < statements.length; si++) {
      await runStatements(db as unknown as StatementExecutor, si);
    }
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await (db as any).transaction().execute(async (trx: any) => {
      // Bound the wait for a lock, in the one place that covers every
      // migration instead of a preamble each author has to remember.
      //
      // The failure this prevents is not a slow migration — it is a stalled
      // instance. An ALTER waiting for ACCESS EXCLUSIVE parks itself at the
      // head of the lock queue, and every ordinary read arriving behind it
      // waits too. One migration blocked on one long-running query takes the
      // whole table offline for as long as it is willing to wait. Failing at
      // five seconds turns that outage into a retry on next boot.
      //
      // `statement_timeout` is off by default on purpose: a backfill on a big
      // table is legitimately slow, and aborting it would leave an operator
      // with an upgrade that can never finish. Instances that would rather
      // fail fast can set a bound.
      await trx.executeQuery({
        sql: `SET LOCAL lock_timeout = '${timeoutSetting('ZVELTIO_MIGRATION_LOCK_TIMEOUT', '5s')}'`,
        parameters: [],
      });
      await trx.executeQuery({
        sql: `SET LOCAL statement_timeout = '${timeoutSetting('ZVELTIO_MIGRATION_STATEMENT_TIMEOUT', '0')}'`,
        parameters: [],
      });

      for (let si = 0; si < statements.length; si++) {
        await runStatements(trx, si);
      }
    });
  }

  const executionMs = Date.now() - startTime;
  const name = filename.replace(/^\d+_/, '').replace('.sql', '').replace(/_/g, ' ');

  // Record in zv_schema_versions
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await (db as any)
    .insertInto('zv_schema_versions')
    .values({
      version: migrationNumber,
      name,
      filename,
      checksum,
      engine_version: process.env.ZVELTIO_VERSION ?? ENGINE_VERSION,
      execution_ms: executionMs,
    })
    .execute()
    .catch((err: Error) => {
      // Tracking failure is non-fatal because the migration itself
      // already succeeded — but a chronic failure means the next run
      // will re-apply the same migration, which can break idempotence.
      console.warn(`[migrations] zv_schema_versions tracking failed for ${filename}:`, err.message);
    });

  // Also record in legacy zv_migrations table for backward compat
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  await (db as any)
    .insertInto('zv_migrations')
    .values({ name: filename.replace('.sql', '') })
    .execute()
    .catch((err: Error) => {
      console.warn(
        `[migrations] legacy zv_migrations row insert failed for ${filename}:`,
        err.message,
      );
    });

  console.log(
    `   ✅ Migration ${String(migrationNumber).padStart(3, '0')} — ${name} (${executionMs}ms)`,
  );
}

export async function runPending(db: Database): Promise<void> {
  const migrationsDir = join(import.meta.dir, 'sql');

  let files: string[];
  let getContent: (file: string) => Promise<string>;

  if (await dirExists(migrationsDir)) {
    // Development / source mode: read from filesystem
    files = listSqlFilesSync(migrationsDir).sort();
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

export async function getAppliedMigrations(db: Database): Promise<
  Array<{
    version: number;
    name: string;
    filename: string;
    applied_at: Date;
    engine_version: string;
  }>
> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

    const allFiles = listSqlFilesSync(migrationsDir)
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
      const content = await Bun.file(join(migrationsDir, file.filename)).text();
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      await (db as any).transaction().execute(async (trx: any) => {
        for (const stmt of splitSqlStatements(down)) {
          await trx.executeQuery({ sql: stmt, parameters: [] });
        }
      });

      // Mark as rolled back
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      await (db as any)
        .updateTable('zv_schema_versions')
        .set({ rolled_back_at: new Date() })
        .where('version', '=', file.version)
        .execute();

      console.log(`   ✅ Migration ${file.version} rolled back`);
    }

    return { success: true };
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
