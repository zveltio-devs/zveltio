#!/usr/bin/env bun
/**
 * A table must have exactly one creator.
 *
 * When two migrations both say `CREATE TABLE IF NOT EXISTS t`, whichever runs
 * first wins and the second is a silent no-op — including every constraint it
 * declares. The loser's schema is never applied and nothing reports it.
 *
 * That is not hypothetical. `zvd_locales` was created by the engine AND by
 * `i18n/translations`. The engine ran first, so the extension's
 * `locale TEXT NOT NULL REFERENCES zvd_locales(code)` never existed on any
 * database. It only surfaced when the engine stopped creating the table and the
 * extension's own schema applied for the first time — at which point that
 * extension's later migration, written against the shape it was now replacing,
 * failed outright.
 *
 * The same shadowing hid a multi-tenancy repair: `zvd_translation_keys.key` was
 * widened to `(tenant_id, key)` by engine migration 036, the table moved to the
 * extension, and the extension's own CREATE — written before that campaign —
 * put the narrow key back on every fresh install.
 *
 * Neither was caught by typecheck, the contract suite, or CI. Both are one
 * `grep` apart, which is what this is.
 *
 * Reads BOTH repos: the engine's `db/migrations/sql` and every extension's
 * `engine/migrations` folder under the sibling extensions checkout. Skipped
 * with a notice when the sibling is absent, because the engine repo has to be
 * cloneable on its own.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Where a CREATE TABLE was found. */
interface Creator {
  /** Owner label — 'engine' or the extension slug. */
  owner: string;
  /** Path, for the error message. */
  file: string;
}

const ENGINE_ROOT = join(import.meta.dir, '..');
const ENGINE_SQL = join(ENGINE_ROOT, 'packages/engine/src/db/migrations/sql');
const EXT_ROOT = join(ENGINE_ROOT, '..', 'zveltio-extensions');
requireSibling(EXT_ROOT, 'duplicate-creators');
import { requireSibling } from './lib/require-sibling.js';

/**
 * Duplicates that are accepted, each with the reason.
 *
 * An entry here is a promise that the shadowing is understood and harmless —
 * NOT a place to park a new one. Adding to this list should be as uncomfortable
 * as the bug it hides, so each needs a sentence saying why the losing CREATE
 * cannot matter.
 */
const ACCEPTED = new Map<string, string>([
  [
    'zv_import_logs',
    "data/import redeclares the engine's table with different column names and " +
      'then reconciles them: `imported_rows` in 001, `format` and `failed_rows` in ' +
      '003_engine_shaped_table.sql — a migration named for exactly this. The losing ' +
      'CREATE contributes nothing and every column the extension reads is added by ' +
      'an ALTER that does run.',
  ],
  [
    'zv_quality_issues',
    'analytics/quality redeclares it, and the two columns its code uses that the ' +
      "engine's shape lacks — `dismissed_by`, `dismissed_at` — are added by ALTER in " +
      'its 001. `dismissed` it shares with the engine. The rest of its CREATE is ' +
      'aspirational and unreached.',
  ],
  [
    'zv_quality_scans',
    'Same extension, same pattern: `created_at` arrives by ALTER in its 001. Nothing ' +
      'it reads depends on the CREATE winning.',
  ],
  [
    'zv_storage_quotas',
    'Three creators — engine, content/media and storage/cloud — and the two ' +
      'extensions declare byte-identical shapes because they are two halves of one ' +
      'feature. All six columns their code needs (`id`, `role_name`, ' +
      '`max_file_size_bytes`, `allowed_extensions`, `created_by`, `created_at`) are ' +
      "added by ALTER in both. `used_bytes` comes from the engine's shape. Verified " +
      'against a live install: the table carries all eleven columns.',
  ],
]);

/** `CREATE TABLE [IF NOT EXISTS] [schema.]name`, comments already stripped. */
const CREATE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi;

/**
 * Line comments stripped before matching.
 *
 * `register.ts` learned this the hard way: a comment containing the words
 * `CREATE TABLE IF NOT EXISTS` (backtick-quoted, so no space where the regex
 * wanted one) made the optional group fail and the capture land on `IF`. Prose
 * about a table is not a declaration of one.
 */
/**
 * The UP half only. A `CREATE TABLE` written to restore a table a rollback just
 * dropped is not a second creator — it never runs on an install.
 *
 * Planted 2026-09-04, and one real file has the shape today:
 * `analytics/quality/…/004_drop_quality_score.sql` recreates `zvd_quality_scores`
 * below its marker. Harmless so far only because it is the same owner as the
 * table's real creator, so `add()` deduplicates it; a different owner doing the
 * same thing would have been reported as shadowing that cannot occur.
 *
 * Same marker and same reason as `upHalf()` in `scripts/lib/install-template.ts`.
 */
function upHalf(sql: string): string {
  const m = /^[ \t]*--[ \t]*DOWN[ \t]*$/im.exec(sql);
  return m ? sql.slice(0, m.index) : sql;
}

function tablesIn(sql: string): string[] {
  const code = upHalf(sql).replace(/--[^\n]*/g, '');
  // `matchAll` rather than a `while ((m = re.exec()))` loop: the assignment form
  // is what the lint ratchet counts, and a shared `/g/` regex carries
  // `lastIndex` between calls, so the exec form also has to be reset by hand.
  return [...code.matchAll(CREATE_RE)].map((m) => m[1].toLowerCase());
}

function sqlFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sqlFilesUnder(full));
    else if (entry.endsWith('.sql')) out.push(full);
  }
  return out;
}

/** Extension slug from `<root>/<a>/<b>/engine/migrations/x.sql` → `a/b`. */
function slugFor(file: string): string {
  const rel = relative(EXT_ROOT, file);
  const parts = rel.split('/');
  const i = parts.indexOf('engine');
  return i > 0 ? parts.slice(0, i).join('/') : parts[0];
}

const creators = new Map<string, Creator[]>();
const add = (table: string, owner: string, file: string): void => {
  const list = creators.get(table) ?? [];
  // One extension splitting a table across its own migrations is not two
  // creators — only distinct owners shadow each other.
  if (!list.some((c) => c.owner === owner)) list.push({ owner, file });
  creators.set(table, list);
};

for (const f of sqlFilesUnder(ENGINE_SQL)) {
  for (const t of tablesIn(await Bun.file(f).text())) add(t, 'engine', f);
}

const siblingPresent = existsSync(EXT_ROOT);
if (siblingPresent) {
  for (const f of sqlFilesUnder(EXT_ROOT)) {
    if (!f.includes('/engine/migrations/')) continue;
    for (const t of tablesIn(await Bun.file(f).text())) add(t, slugFor(f), f);
  }
} else {
  console.log('[duplicate-creators] sibling zveltio-extensions not found — engine only.');
}

const REPORT_ONLY = process.argv.includes('--report');
const dupes = [...creators.entries()]
  .filter(([, c]) => c.length > 1)
  .sort(([a], [b]) => a.localeCompare(b));

const unexplained = dupes.filter(([t]) => !ACCEPTED.has(t));

if (REPORT_ONLY) {
  console.log(
    `[duplicate-creators] ${creators.size} tables, ${dupes.length} with more than one creator\n`,
  );
  for (const [table, cs] of dupes) {
    console.log(`  ${table}\n      ${cs.map((c) => c.owner).join('  +  ')}`);
  }
  process.exit(0);
}

if (unexplained.length > 0) {
  console.error(
    `\n❌ ${unexplained.length} table(s) are created by more than one migration owner.\n` +
      `   Whichever runs first wins; the other CREATE is a silent no-op and every\n` +
      `   constraint it declares is never applied.\n`,
  );
  for (const [table, cs] of unexplained) {
    console.error(`  ${table}`);
    for (const c of cs)
      console.error(`      ${c.owner.padEnd(28)} ${relative(ENGINE_ROOT, c.file)}`);
  }
  console.error(
    `\n  Fix by giving the table ONE owner: the loser should stop creating it, or the\n` +
      `  winner should. If the shadowing is genuinely harmless, add the table to\n` +
      `  ACCEPTED in this file WITH the reason.\n`,
  );
  process.exit(1);
}

console.log(
  `[duplicate-creators] OK — ${creators.size} tables, each with one creator` +
    (ACCEPTED.size > 0 ? ` (${ACCEPTED.size} accepted duplicate(s))` : '') +
    (siblingPresent ? '' : ' (engine only — sibling absent)'),
);
