import { sqlState } from '../bun-sql-quirks.js';
import type { Database } from '../index.js';
import { sql } from 'kysely';
import { join } from 'path';
import { createHash } from 'crypto';
import { EMBEDDED_MIGRATIONS } from './embedded.js';
import { ENGINE_VERSION } from '../../version.js';
import { AdvisoryLockTimeout, withAdvisoryLock } from '../advisory-lock.js';
import { assertSupportedPostgres } from '../postgres-version.js';

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
  let eString = false; // E'...' — backslash escapes the next character
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
      if (eString && ch === '\\' && next !== undefined) {
        current += next;
        i += 2;
      } else if (ch === "'" && next === "'") {
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
      eString = /(^|[^\w$])[eE]$/.test(current);
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
  const sqlstate = sqlState(err);

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
 * The `SET LOCAL` pair every transactional migration opens with — the engine's
 * own (`applyMigration()`) and every extension's (`runExtensionMigrations()`).
 * One definition so the two runners cannot drift: the extension runner went
 * without it, and an extension ALTER behind one long reader waited forever at
 * the head of the lock queue with the table's traffic stalled behind it.
 *
 * Transactional only: a `-- NO TRANSACTION` migration gets neither (see the
 * comment on that path in `applyMigration()`).
 */
export function migrationTimeoutPreamble(): string[] {
  return [
    `SET LOCAL lock_timeout = '${timeoutSetting('ZVELTIO_MIGRATION_LOCK_TIMEOUT', '5s')}'`,
    `SET LOCAL statement_timeout = '${timeoutSetting('ZVELTIO_MIGRATION_STATEMENT_TIMEOUT', '0')}'`,
  ];
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

/**
 * The database and this build disagree about what migration N *is*.
 *
 * Two shapes reach here. Either an already-applied file was edited in place, or
 * the number was reused by a different file — which is what a squash does to
 * every database built before it.
 *
 * It fails closed. The old behaviour was `console.warn` + skip. Measured on a
 * database built by the real v3.0.0-beta.62 chain, against binaries compiled
 * from both sides of this change:
 *
 *   `zveltio migrate` (and POST /admin/migrate), before:
 *     two warnings, "✅ Migrations complete", exit 0 — and NOTHING applied.
 *     Neither path has any other guard. That is the hole.
 *
 *   Engine boot, before:
 *     the same two warnings, then exit 1 — but from `checkSchemaCompatibility`,
 *     which fires on `recorded (46) > MAX_SCHEMA_VERSION (2)`. So boot was
 *     already refusing. What it refused WITH was wrong: "Database schema is
 *     newer than this engine version! Update Zveltio to the latest version" —
 *     advice that cannot help, since the operator is already on the latest and
 *     the chain was squashed, not outrun.
 *
 * That version comparison is also the reason a divergence at or BELOW
 * MAX_SCHEMA_VERSION went unnoticed entirely: an applied file edited in place
 * leaves the number unchanged, so the guard never fires and the old warn-and-
 * continue was the only thing standing there.
 *
 * The old warning text ("File may have been modified after being applied") named
 * only one of the two causes and neither filename, so an operator seeing it had
 * no way to tell which had happened.
 */
function reportDivergence(migrationNumber: number, shipped: string, recorded: string): void {
  const cause =
    recorded !== shipped
      ? `migration ${migrationNumber} is recorded as "${recorded}" but this build ships ` +
        `"${shipped}" — the chain was renumbered or squashed, so this database cannot be ` +
        'upgraded in place'
      : `migration ${migrationNumber} ("${shipped}") was edited after it was applied — the ` +
        'database holds the old version and no longer matches this build';
  const message =
    `Migration chain divergence: ${cause}. Refusing to start, because continuing would leave ` +
    'the schema silently behind the binary. Restore from a backup taken on the matching ' +
    'version, or rebuild the database. Set ZVELTIO_ALLOW_MIGRATION_DIVERGENCE=1 to proceed ' +
    'anyway, which accepts a schema this build was not written against.';
  if (process.env.ZVELTIO_ALLOW_MIGRATION_DIVERGENCE !== '1') {
    throw new Error(message);
  }
  console.warn(
    `⚠️  ${message}\n⚠️  Overridden by ZVELTIO_ALLOW_MIGRATION_DIVERGENCE=1 — proceeding.`,
  );
}

/**
 * What this build ships that the database has not applied — and, on the way,
 * a check that what it HAS applied is what this build ships.
 *
 * "Applied" has one source of truth: a row in `zv_schema_versions` with
 * `rolled_back_at IS NULL`. `zv_migrations` also gets a row per core file, but
 * nothing reads it for that purpose; it is the extensions' ledger and a legacy
 * mirror here. Deleting a core row from it changes nothing.
 *
 * Pending is a SET difference — shipped versions with no such row — not
 * "numbers above the high-water mark". Two PRs that each add a migration merge
 * in either order, and a backported hotfix gets a number below the head. Boot
 * used to ask `lastApplied >= MAX_SCHEMA_VERSION` and return when it was true,
 * so a database that recorded 048 before 047 existed never ran 047, and said
 * nothing. Measured: `tests/harness/migration-out-of-order.test.ts`.
 *
 * The identity check runs BEFORE anything decides there is nothing to do. A
 * squashed database — 46 rows recorded, 2 files shipped, numbers reused by
 * different files — must be refused, not read as "ahead of me". On the boot
 * path a later guard did catch that case, for the wrong reason and with the
 * wrong advice; see `reportDivergence`. On `zveltio migrate` there was no later
 * guard at all.
 *
 * One query, so a boot with nothing pending stays one round trip.
 */
export async function pendingMigrations(
  db: Database,
  opts: ChainOptions = {},
): Promise<MigrationState> {
  return (await readPlan(db, opts, true)).state;
}

/**
 * The plan both runners and the reporting path share: the shipped set, what the
 * database recorded, and what is pending. `checkIdentity` is the refusal
 * described on `pendingMigrations`.
 */
async function readPlan(
  db: Database,
  opts: ChainOptions,
  checkIdentity: boolean,
): Promise<{
  shipped: ShippedMigration[];
  byVersion: Map<number, RecordedRow>;
  state: MigrationState;
}> {
  const { shipped, byVersion } = await readChain(db, opts);
  if (checkIdentity) {
    for (const m of shipped) {
      const row = byVersion.get(m.version);
      if (!row || row.checksum === 'baseline') continue;
      if (row.checksum !== m.checksum || row.filename !== m.filename) {
        reportDivergence(m.version, m.filename, row.filename);
      }
    }
  }
  return { shipped, byVersion, state: summarize(shipped, byVersion) };
}

/**
 * `ignoreBaseline` reads the build as every beta did: the baseline file does not
 * exist, so a fresh database runs the replaced chain file by file and a rollback
 * may go below it. For the tests of the replaced files and the equivalence test
 * (`tests/harness/baseline-equivalence.test.ts`), which must keep building the
 * chain until those files are deleted. Never reachable from the CLI or a route.
 */
export interface ChainOptions {
  ignoreBaseline?: boolean;
}

/**
 * A baseline: one file standing for a whole released chain (the Django
 * `replaces` pattern). Its header names the release whose chain it replaces and
 * every replaced file with the checksum the runner recorded for it:
 *
 *   -- BASELINE OF v3.0.0-beta.79
 *   -- REPLACES 001_initial.sql 41b7e428f8b77e0b
 *
 * A fresh database runs only the baseline and records the replaced files as
 * applied, so its ledger reads exactly as one built by the chain. A database
 * that ran the whole chain records the baseline without running it. A database
 * that stopped partway is refused (`assertWholeChain`). Nothing in this build
 * ever applies a replaced file, so the old files' DOWN sections and their
 * batch-without-commit backfills (009-011) are unreachable from a fresh install.
 */
export interface Baseline {
  release: string;
  replaces: Array<{ version: number; filename: string; checksum: string }>;
}

export function parseBaseline(content: string): Baseline | null {
  const release = /^--\s*BASELINE OF\s+(\S+)\s*$/m.exec(content)?.[1];
  if (!release) return null;
  const replaces = [
    ...content.matchAll(/^--\s*REPLACES\s+((\d+)_\S+\.sql)\s+([0-9a-f]{16})\s*$/gm),
  ].map((m) => ({ version: Number(m[2]), filename: m[1], checksum: m[3] }));
  if (replaces.length === 0) throw new Error(`Baseline of ${release} declares no REPLACES line`);
  return { release, replaces };
}

/**
 * The refusal the owner decision asks for: a database that has not run the whole
 * replaced chain cannot be brought to the baseline by this build, which no
 * longer applies the old files one by one. The release named in the header can.
 */
function assertWholeChain(m: ShippedMigration, byVersion: Map<number, RecordedRow>): void {
  const b = m.baseline as Baseline;
  const missing = b.replaces.filter((r) => {
    const row = byVersion.get(r.version);
    return (
      !row ||
      row.filename !== r.filename ||
      (row.checksum !== r.checksum && row.checksum !== 'baseline')
    );
  });
  if (missing.length === 0) return;
  throw new Error(
    `This database has not run the whole migration chain of ${b.release}: ${missing.length} of ` +
      `the ${b.replaces.length} migrations ${m.filename} replaces are not applied (first: ` +
      `${missing[0].filename}). This build no longer applies them one by one. Upgrade to ` +
      `${b.release} first — its boot finishes the chain — then to this version. Nothing was changed.`,
  );
}

export interface MigrationState {
  /** Highest version recorded as applied, shipped or not (0 on a fresh database). */
  lastApplied: number;
  /** Shipped but not applied, in the order they will run. */
  pending: Array<{ version: number; filename: string }>;
}

/**
 * The same set difference as `pendingMigrations`, without refusing a diverged
 * chain — for reporting (boot's compatibility line, /api/health/version,
 * /admin/schema), where `MIGRATIONS_AUTO=false` must still be able to say a
 * migration below the head is missing.
 */
export async function migrationState(db: Database): Promise<MigrationState> {
  const { shipped, byVersion } = await readChain(db);
  return summarize(shipped, byVersion);
}

interface RecordedRow {
  version: number;
  filename: string;
  checksum: string;
}

interface ShippedMigration extends RecordedRow {
  content: string;
  baseline: Baseline | null;
}

/** The one read both of the above share. */
async function readChain(
  db: Database,
  opts: ChainOptions = {},
): Promise<{ shipped: ShippedMigration[]; byVersion: Map<number, RecordedRow> }> {
  const shipped = await listShippedMigrations(opts);

  // Raw `sql` rather than the query builder: `zv_schema_versions` is not in the
  // Kysely `Database` type, and every other reader here reaches for `db as any`
  // to get past that. A typed template needs no suppression.
  let recorded: RecordedRow[];
  try {
    const res = await sql<RecordedRow>`
      SELECT version, filename, checksum FROM zv_schema_versions
      WHERE rolled_back_at IS NULL`.execute(db);
    // A rolled-back row is pending again: its checksum is from a file that may
    // since have been edited, which is the point of rolling back.
    recorded = res.rows;
  } catch (err) {
    // 42P01: the tracking table does not exist yet, so this is a fresh database
    // and there is nothing to disagree with. Any other error means the answer is
    // unknown, and an unknown answer must not read as "compatible".
    if (sqlState(err) !== '42P01') throw err;
    recorded = [];
  }
  return { shipped, byVersion: new Map(recorded.map((r) => [Number(r.version), r])) };
}

function summarize(shipped: ShippedMigration[], byVersion: Map<number, unknown>): MigrationState {
  let pending = shipped.filter((m) => !byVersion.has(m.version));
  // A fresh database runs the baseline and nothing it replaces. Anywhere else a
  // missing replaced file stays pending: on a database short of the baseline
  // that is what the refusal names, and on one past it a lost ledger row is
  // re-applied as before.
  const baseline = pending.find((m) => m.baseline);
  if (baseline && byVersion.size === 0) {
    const replaced = new Set(baseline.baseline?.replaces.map((r) => r.version));
    pending = pending.filter((m) => !replaced.has(m.version));
  }
  return {
    lastApplied: Math.max(0, ...byVersion.keys()),
    pending: pending.map(({ version, filename }) => ({ version, filename })),
  };
}

/** `pendingMigrations` for callers that only need the identity check. */
export async function assertChainCompatible(db: Database): Promise<void> {
  await pendingMigrations(db);
}

/**
 * Every migration file this build ships, by filename: the chain under `sql/` and
 * any baseline under `baseline/` in source mode, `EMBEDDED_MIGRATIONS` in a
 * compiled binary, where neither directory exists. The one reader of the set, so
 * the runner, the reporting path and rollback cannot disagree about it.
 */
async function readShippedFiles(): Promise<Map<string, string>> {
  if (!(await dirExists(join(import.meta.dir, 'sql')))) {
    return new Map(Object.entries(EMBEDDED_MIGRATIONS));
  }
  const out = new Map<string, string>();
  for (const sub of ['sql', 'baseline']) {
    const dir = join(import.meta.dir, sub);
    if (!(await dirExists(dir))) continue;
    for (const f of listSqlFilesSync(dir)) out.set(f, await Bun.file(join(dir, f)).text());
  }
  return out;
}

function upChecksum(content: string): string {
  return createHash('sha256').update(parseMigrationFile(content).up).digest('hex').slice(0, 16);
}

/** The migrations this build ships, with their numbers and content checksums. */
async function listShippedMigrations(opts: ChainOptions = {}): Promise<ShippedMigration[]> {
  const out: ShippedMigration[] = [];
  for (const [filename, content] of await readShippedFiles()) {
    const baseline = parseBaseline(content);
    if (baseline && opts.ignoreBaseline) continue;
    out.push({
      version: getMigrationNumber(filename),
      filename,
      checksum: upChecksum(content),
      content,
      baseline,
    });
  }
  // Numeric, then by name: the order the runner applies them in.
  return out.sort((a, b) => a.version - b.version || a.filename.localeCompare(b.filename));
}

async function applyMigration(
  db: Database,
  migrationNumber: number,
  filename: string,
  fileContent: string,
  // Runs inside the migration's transaction, after its statements: what must
  // commit or roll back with them (the baseline's ledger rows).
  inTransaction?: (trx: Database) => Promise<void>,
): Promise<boolean> {
  const startTime = Date.now();
  const { up } = parseMigrationFile(fileContent);
  const checksum = upChecksum(fileContent);

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
  let existing: { version: number; checksum: string; filename: string } | undefined;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    existing = await (db as any)
      .selectFrom('zv_schema_versions')
      .select(['version', 'checksum', 'filename'])
      .where('version', '=', migrationNumber)
      // A rolled-back version is pending again; its row is reused on insert.
      .where('rolled_back_at', 'is', null)
      .executeTakeFirst();
  } catch (err) {
    if (sqlState(err) !== '42P01') throw err;
  }

  if (existing) {
    if (existing.checksum !== checksum && existing.checksum !== 'baseline') {
      // This used to be a console.warn followed by `return`, which is the
      // fail-open shape: the database and the binary disagree about what
      // migration N *is*, and the engine booted anyway.
      //
      // Reproduced on a real beta.62 database: after the chain was squashed
      // (45 files folded into 001), upgrading the binary printed three of
      // these warnings, exited 0, and applied NOTHING. No passkey table, no
      // tenancy hierarchy, no policy rewrite — the install kept running on
      // the old schema while reporting a successful start. The skip is silent
      // because the runner keys on the version NUMBER: 002 and 003 were
      // already taken by different files, so the new ones were never eligible.
      //
      // The warning text was wrong too. "File may have been modified after
      // being applied" describes only one of the two causes, and it named
      // neither file, so the operator could not tell which.
      reportDivergence(migrationNumber, filename, existing.filename);
    }
    return false; // Already applied (by a concurrent runner since the plan was read)
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    try {
      await recordApplied(db, migrationNumber, filename, checksum, Date.now() - startTime);
    } catch (err) {
      // Nothing to roll back with: the statements above have committed. Not
      // recorded means pending, so the next run applies the file again.
      throw new Error(
        `Migration ${migrationNumber} (${filename}) ran but could not be recorded, so it is ` +
          `still pending and the next run applies it again: ${(err as Error).message}`,
        { cause: err },
      );
    }
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
      for (const stmt of migrationTimeoutPreamble()) {
        await trx.executeQuery({ sql: stmt, parameters: [] });
      }

      for (let si = 0; si < statements.length; si++) {
        await runStatements(trx, si);
      }
      if (inTransaction) await inTransaction(trx as Database);
      // In the migration's transaction: a file that cannot be recorded is
      // rolled back with its row, not left applied and pending.
      await recordApplied(trx, migrationNumber, filename, checksum, Date.now() - startTime);
    });
  }

  console.log(
    `   ✅ Migration ${String(migrationNumber).padStart(3, '0')} — ${migrationName(filename)} (${Date.now() - startTime}ms)`,
  );
  return true;
}

function migrationName(filename: string): string {
  return filename.replace(/^\d+_/, '').replace('.sql', '').replace(/_/g, ' ');
}

/**
 * The ledger rows for one applied migration. Throws on failure: both tracking
 * inserts used to end `.catch(console.warn)` after the migration had committed,
 * so a refused row left the schema changed, nothing recorded, the file reported
 * applied, and the next run applying it again (tests/harness/migration-tracking-fatal.test.ts).
 * Inside a transaction the swallowed error also aborted it. Both tables come
 * from the first migration, so neither is ever legitimately missing here.
 * Schema-qualified because a baseline empties `search_path` for its transaction.
 */
async function recordApplied(
  db: Database,
  migrationNumber: number,
  filename: string,
  checksum: string,
  executionMs: number,
): Promise<void> {
  const name = migrationName(filename);

  await db
    .withSchema('public')
    .insertInto('zv_schema_versions')
    .values({
      // INTEGER in the database; the Kysely type says string.
      version: String(migrationNumber),
      name,
      filename,
      checksum,
      engine_version: process.env.ZVELTIO_VERSION ?? ENGINE_VERSION,
      execution_ms: executionMs,
    })
    // `version` is UNIQUE and `rollbackMigration` keeps the row, marked: a
    // re-applied migration reuses it.
    .onConflict((oc) =>
      oc.column('version').doUpdateSet({
        name,
        filename,
        checksum,
        engine_version: process.env.ZVELTIO_VERSION ?? ENGINE_VERSION,
        execution_ms: executionMs,
        applied_at: new Date(),
        rolled_back_at: null,
      }),
    )
    .execute();

  // Also record in legacy zv_migrations table for backward compat
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  await (db as any)
    .withSchema('public')
    .insertInto('zv_migrations')
    .values({ name: filename.replace('.sql', '') })
    // A re-applied (rolled-back) migration already has its row.
    .onConflict((oc: { column: (c: string) => { doNothing: () => unknown } }) =>
      oc.column('name').doNothing(),
    )
    .execute();
}

/**
 * The replaced files' ledger rows, written in the baseline's own transaction: a
 * baseline that committed without them would read on the next boot as a chain
 * stopped partway and be refused. Schema-qualified because the baseline, like
 * any `pg_dump` output, empties `search_path` for the rest of its transaction.
 */
async function recordReplaced(trx: Database, b: Baseline): Promise<void> {
  const engineVersion = process.env.ZVELTIO_VERSION ?? ENGINE_VERSION;
  for (const r of b.replaces) {
    await sql`
      INSERT INTO public.zv_schema_versions
        (version, name, filename, checksum, engine_version, execution_ms)
      VALUES (${r.version}, ${migrationName(r.filename)}, ${r.filename}, ${r.checksum},
              ${engineVersion}, 0)`.execute(trx);
    await sql`
      INSERT INTO public.zv_migrations (name) VALUES (${r.filename.replace('.sql', '')})
      ON CONFLICT (name) DO NOTHING`.execute(trx);
  }
}

/**
 * Applies every shipped migration the database has not applied, lowest number
 * first, and returns the filenames it applied. See `pendingMigrations` for what
 * "not applied" means and why it is not "above the high-water mark".
 */
export async function runPending(db: Database, opts: ChainOptions = {}): Promise<string[]> {
  const { shipped, byVersion, state } = await readPlan(db, opts, true);
  const { lastApplied, pending } = state;
  const byFile = new Map(shipped.map((m) => [m.filename, m]));
  const fresh = byVersion.size === 0;

  // Before anything runs: a chain stopped partway is refused whole, not after
  // its missing files were applied by a build that no longer means to.
  const baseline = pending.map((p) => byFile.get(p.filename)).find((m) => m?.baseline);
  if (baseline && !fresh) assertWholeChain(baseline, byVersion);

  const applied: string[] = [];
  for (const { version, filename } of pending) {
    const m = byFile.get(filename) as ShippedMigration;
    if (m.baseline) {
      if (fresh) {
        const b = m.baseline;
        if (
          await applyMigration(db, version, filename, m.content, (trx) => recordReplaced(trx, b))
        ) {
          applied.push(filename);
        }
      } else {
        // The whole chain is applied (asserted above): this database already is
        // what the baseline builds. Recorded, not run.
        await recordApplied(db, version, filename, m.checksum, 0);
        console.log(
          `   ✅ Migration ${String(version).padStart(3, '0')} — ${migrationName(filename)} ` +
            `(recorded: this database ran the whole chain of ${m.baseline.release})`,
        );
        applied.push(filename);
      }
      continue;
    }
    if (version < lastApplied) {
      // Legitimate (parallel PRs, a backported fix) but worth a line: the file
      // was written against a schema without the higher ones, and runs on one with.
      console.warn(
        `⚠️  [migrations] ${filename} is applied out of order: this database already ` +
          `ran migration ${lastApplied}.`,
      );
    }
    if (await applyMigration(db, version, filename, m.content)) {
      applied.push(filename);
    }
  }
  // A table a migration just created holds the request role's default DML grant
  // (001), control tables too; take the role's grants back to what boot sets.
  // tests/harness/control-table-grants.test.ts.
  if (applied.length > 0) {
    const { ensureRlsEnforcementRole } = await import('../../lib/tenancy/index.js');
    await ensureRlsEnforcementRole(db);
  }
  return applied;
}

/**
 * Stable 64-bit advisory lock key — unchanged since the session-lock version,
 * so a replica still running that one excludes this one. 'zveltio\0' as a
 * big-endian bigint. Advisory locks live apart from row/table locks and block
 * no reads or writes.
 */
const MIGRATIONS_LOCK_KEY = 0x7a76656c74696f00n;

/**
 * Runs `fn` holding the one lock every schema-changing runner shares: boot
 * (`autoMigrate`), `zveltio migrate`, `bun src/index.ts migrate`,
 * POST /admin/migrate and rollback.
 *
 * Only boot used to take it. The others ran unlocked, so `zveltio migrate`
 * beside a booting replica could apply the same file twice — a seed INSERT or a
 * backfill is not idempotent — or record it twice into the UNIQUE version.
 *
 * Not reentrant: the lock is held by a separate transaction, so calling this
 * from inside `fn` waits on itself. `runPending` is the unlocked core for that.
 *
 * The wait is bounded by ZVELTIO_MIGRATION_LOCK_WAIT, not by whatever
 * statement_timeout the server or role carries: that one is set for queries,
 * and cancelled a waiting replica into a restart loop with a bare Postgres
 * message. Read before the wait so a malformed value fails at once.
 */
export async function withMigrationLock<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  const maxWait = timeoutSetting('ZVELTIO_MIGRATION_LOCK_WAIT', '10min');
  // Every schema change comes through here, whatever handle it was given.
  await assertSupportedPostgres(db);
  try {
    return await withAdvisoryLock(db, MIGRATIONS_LOCK_KEY, fn, { maxWait });
  } catch (err) {
    if (err instanceof AdvisoryLockTimeout) {
      throw new Error(
        `Another instance has been running migrations for more than ${maxWait}, so this one ` +
          "stopped waiting. Check that instance's log: if it is still migrating, restart this " +
          'one when it finishes, or raise ZVELTIO_MIGRATION_LOCK_WAIT for this upgrade.',
        { cause: err },
      );
    }
    throw err;
  }
}

/** `runPending` under the migration lock — for the CLI, the admin route and external callers. */
export async function runMigrations(db: Database): Promise<string[]> {
  return withMigrationLock(db, () => runPending(db));
}

export async function getLastAppliedMigration(db: Database): Promise<number> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
  opts: ChainOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    // Same lock as every runner: a rollback beside a booting replica would
    // otherwise undo a file while it is being re-applied.
    return await withMigrationLock(db, async (): Promise<{ success: boolean; error?: string }> => {
      // Both modes, through the one reader. This was the third reader of the
      // migration set and the only one that read the directory unconditionally:
      // in a compiled binary that directory does not exist, `scanSync` threw
      // ENOENT, and `zveltio rollback` failed every time on the artifact that
      // actually ships. Measured: scanSync on a missing directory throws rather
      // than returning nothing.
      const files = await readShippedFiles();
      const allFiles = [...files.keys()]
        .filter((f) => !(opts.ignoreBaseline && parseBaseline(files.get(f) as string)))
        .map((f) => ({ filename: f, version: getMigrationNumber(f) }))
        .filter((f) => f.version > targetVersion)
        .sort((a, b) => b.version - a.version); // Descending for rollback
      const readMigration = async (filename: string): Promise<string> =>
        files.get(filename) as string;

      // Only what is applied now: a DOWN run against a migration that never ran,
      // or already ran its DOWN, undoes nothing it did.
      // Not `getAppliedMigrations`: it answers [] on any error, which would
      // report an unreachable database as "Nothing to rollback".
      const applied = new Set(
        (
          await sql<{ version: number }>`
            SELECT version FROM zv_schema_versions WHERE rolled_back_at IS NULL`.execute(db)
        ).rows.map((r) => Number(r.version)),
      );
      const toRollBack = allFiles.filter((f) => applied.has(f.version));

      if (toRollBack.length === 0) {
        return { success: false, error: 'Nothing to rollback' };
      }

      // Below a baseline is an empty database, which is not a supported
      // operation: refused before any DOWN runs. The DOWN of 001_initial.sql
      // that this used to reach stopped at DROP ROLE zveltio_worker with 26 of
      // 72 tables still there, and the tables later files folded in had none.
      for (const file of toRollBack) {
        const b = parseBaseline(await readMigration(file.filename));
        if (!b) continue;
        return {
          success: false,
          error:
            `Migration ${file.version} (${file.filename}) is the baseline of ${b.release}: it ` +
            `replaces migrations ${b.replaces[0].filename} to ` +
            `${b.replaces[b.replaces.length - 1].filename} and cannot be rolled back. Rolling ` +
            `back below it would mean an empty database, which is not a supported operation; ` +
            `restore a backup taken before the upgrade instead. The lowest target is ${file.version}.`,
        };
      }

      for (const file of toRollBack) {
        const content = await readMigration(file.filename);
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
        const markRolledBack = (exec: Database) =>
          exec
            .updateTable('zv_schema_versions')
            .set({ rolled_back_at: new Date() })
            .where('version', '=', String(file.version))
            .execute();
        if (isNonTransactional(content)) {
          // Same rule as the UP path: a `-- NO TRANSACTION` file's DOWN may hold
          // `DROP INDEX CONCURRENTLY`, which a transaction refuses outright.
          for (const stmt of splitSqlStatements(down)) {
            // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
            await (db as any).executeQuery({ sql: stmt, parameters: [] });
          }
          await markRolledBack(db);
        } else {
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
          await (db as any).transaction().execute(async (trx: any) => {
            // The UP path's timeouts, so a DOWN cannot stall a table's traffic.
            for (const stmt of migrationTimeoutPreamble()) {
              await trx.executeQuery({ sql: stmt, parameters: [] });
            }
            // Where this rollback stops, for a DOWN that guards a lower file's
            // DOWN: 090 refuses only when 087's DOWN is going to run.
            await sql`SELECT set_config('zveltio.rollback_target', ${String(targetVersion)}, true)`.execute(
              trx,
            );
            for (const stmt of splitSqlStatements(down)) {
              await trx.executeQuery({ sql: stmt, parameters: [] });
            }
            await markRolledBack(trx as Database);
          });
        }

        console.log(`   ✅ Migration ${file.version} rolled back`);
      }

      return { success: true };
    });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
