#!/usr/bin/env bun
/**
 * Is this value going into a `jsonb` column as a value, or as a string?
 *
 * `lib/jsonb.ts` exists because four columns were found holding JSON *text*
 * instead of JSON: bind `JSON.stringify(v)` to a `jsonb` column and the driver
 * stores a jsonb STRING, so `jsonb_typeof` says `string`, `col->>'k'` is NULL
 * and `col ? 'k'` is false. `zv_api_keys.scopes` was the worst of them — an
 * authorization check written the natural SQL way would have denied a key its
 * own scopes.
 *
 * That change fixed the writers it knew about and added the helper. It added no
 * gate, and the helper's own commit message is the argument for one: the reason
 * this survives is that the readers compensate, so nothing observable breaks
 * until somebody writes the SQL that assumes the shape. A fifth site is
 * therefore not a hypothetical, and there WAS a fifth site —
 * `zvd_collections.fields`, written as a jsonb string by three separate
 * writers, with `ddl-manager.ts` carrying the matching `typeof row.fields ===
 * 'string' ? JSON.parse(…)` on the way back out. This gate is what found it.
 *
 * ── What it checks ────────────────────────────────────────────────
 *
 * Which columns are `jsonb` comes from the migrations of BOTH repositories, per
 * table — the column NAME alone is far too coarse, because `config`, `data`,
 * `details` and `fields` are each `jsonb` on one table and `text` on another.
 * What the code claims comes from the Kysely chain: `insertInto('t')` or
 * `updateTable('t')`, then the object literal in the `.values()` / `.set()` /
 * `.doUpdateSet()` that follows.
 *
 * Two forms are flagged, both of which the helper's docstring records as
 * measured against this driver:
 *
 *   col: JSON.stringify(v)                  → a jsonb STRING. Always wrong.
 *   col: sql`${JSON.stringify(v)}::jsonb`   → still a jsonb string. The obvious
 *                                             repair, and a trap: the driver has
 *                                             already encoded the parameter as
 *                                             JSON, so the cast re-wraps it.
 *
 * The correct form is `toJsonb(v)` — `${JSON.stringify(v)}::text::jsonb` — which
 * is right for every JSON type, arrays included. Passing the raw value is NOT
 * accepted as correct here even though it works for objects: it renders a JS
 * array as a Postgres array literal, so `[{a:1}]` lands as the string
 * `{"[object Object]"}`. That one cannot be seen without type inference, so this
 * gate does not claim to catch it; use the helper and the question does not
 * arise.
 *
 * Ratcheted, not swept: the count may fall, never rise.
 *
 * Usage:
 *   bun run scripts/check-jsonb-binding.ts            # gate
 *   bun run scripts/check-jsonb-binding.ts --report   # list every site
 *   bun run scripts/check-jsonb-binding.ts --update   # rewrite the baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { requireSibling } from './lib/require-sibling.js';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = process.env.EXTENSIONS_DIR ?? join(ROOT, '..', 'zveltio-extensions');
const BASELINE = join(ROOT, 'quality-gates', 'jsonb-binding.json');

// An absent sibling is not a clean sibling.
//
// The scan is `if (existsSync(EXT_ROOT))` in two places, so without the
// extensions checkout it quietly covered the engine alone and said so only in a
// number nobody reads: `OK — 0 site(s) across 29 table(s)` with no sibling,
// against `across 115 table(s)` with one. That is the fail-open Block C fixed
// for five other gates, and it lands harder here — every one of the sites this
// gate's own history is about lived in an extension.
//
// Skipped when EXTENSIONS_DIR points somewhere explicitly: that is a caller
// asking for a narrower scan on purpose, which is how the probe suites use it.
if (!process.env.EXTENSIONS_DIR) requireSibling(EXT_ROOT, 'jsonb-binding');

/**
 * A literal `$` + `{` for the two places this file has to NAME the wrong form
 * rather than perform it. Written whole it trips `noTemplateCurlyInString`,
 * which is a rule worth keeping; built from pieces it stays text.
 */
const INTERP_OPEN = `$${'{'}`;

const REPORT = process.argv.includes('--report');
const UPDATE = process.argv.includes('--update');

// ── Which columns are actually jsonb ──────────────────────────────

/** table → set of jsonb column names, from the SQL of both repositories. */
function jsonbColumns(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  const add = (table: string, col: string) => {
    const t = table.replace(/^public\./, '').toLowerCase();
    const set = byTable.get(t) ?? new Set<string>();
    set.add(col.toLowerCase());
    byTable.set(t, set);
  };

  for (const file of sqlFiles()) {
    // Comments first: a `--` line mentioning jsonb is not a declaration.
    const sql = readFileSync(file, 'utf8').replace(/--[^\n]*/g, '');

    // CREATE TABLE … ( … col jsonb … )
    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w.]+)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
    while ((m = create.exec(sql)) !== null) {
      const body = balanced(sql, create.lastIndex - 1);
      if (body === null) continue;
      for (const line of body.split('\n')) {
        const col = /^\s*"?([a-z_][\w]*)"?\s+jsonb\b/i.exec(line);
        if (col) add(m[1]!, col[1]!);
      }
    }

    // ALTER TABLE … ADD COLUMN [IF NOT EXISTS] col jsonb
    const alter =
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?([\w.]+)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][\w]*)"?\s+jsonb\b/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
    while ((m = alter.exec(sql)) !== null) add(m[1]!, m[2]!);
  }
  return byTable;
}

function sqlFiles(): string[] {
  const out: string[] = [];
  const engine = join(ROOT, 'packages/engine/src/db/migrations/sql');
  if (existsSync(engine)) {
    out.push(
      ...readdirSync(engine)
        .filter((f) => f.endsWith('.sql'))
        .map((f) => join(engine, f)),
    );
  }
  if (existsSync(EXT_ROOT)) walk(EXT_ROOT, (p) => p.endsWith('.sql'), out);
  return out;
}

function walk(dir: string, keep: (p: string) => boolean, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === '.git' || e === '.svelte-kit') continue;
    const p = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
}

/** The text inside the `(…)` or `{…}` starting at `open`, or null if unbalanced. */
function balanced(src: string, open: number): string | null {
  const close = src[open] === '(' ? ')' : '}';
  const openCh = src[open]!;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === openCh) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

// ── What the code claims ──────────────────────────────────────────

interface Site {
  file: string;
  line: number;
  table: string;
  column: string;
  form: string;
}

/** Split an object-literal body on top-level commas. */
function topLevelPairs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/** How far past `insertInto('t')` a `.values({…})` is still the same statement. */
const CHAIN_WINDOW = 6000;

/**
 * Line and block comments blanked, newlines and offsets preserved.
 *
 * String-aware, because the naive `replace(/\/\*[\s\S]*?\*\//g, '')` does not
 * know what a string is and a `/*` inside one eats everything to the next
 * `*` + `/`. Same walker as `check-atomic-writes.ts`, for the same reason.
 *
 * Added 2026-09-04 after planting two shapes that both went red on a clean
 * tree: a commented-out write, and — worse — a JSDoc header DOCUMENTING the
 * wrong form. The second is this repository's house style; every gate in E01
 * shows the form it refuses in its own header, and this file has to do it twice
 * (see `INTERP_OPEN` above, which exists precisely so the text can name the
 * wrong form without performing it). So the first person to write
 * `col: JSON.stringify(v)` into a comment explaining this gate would have made
 * the gate fail on a tree with no defect in it — and a ratchet that fires on
 * prose is one somebody switches off.
 *
 * Blanking rather than deleting: every offset downstream, including the line
 * numbers this file reports, stays the file's own.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function scan(file: string, jsonb: Map<string, Set<string>>): Site[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const found: Site[] = [];

  const entry = /\.(insertInto|updateTable)\(\s*['"`]([\w.]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
  while ((m = entry.exec(src)) !== null) {
    const cols = jsonb.get(m[2]!.replace(/^public\./, '').toLowerCase());
    if (!cols) continue;

    // Every object literal opened by .values/.set/.doUpdateSet in the chain that
    // follows. `doUpdateSet` matters: an ON CONFLICT branch is a second writer
    // of the same column and was wrong in exactly the same way.
    const window = src.slice(m.index, m.index + CHAIN_WINDOW);
    const setter = /\.(values|set|doUpdateSet)\(\s*(?:\([^)]*\)\s*=>\s*[\w.]*\(?\s*)?\{/g;
    let s: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: the standard exec loop
    while ((s = setter.exec(window)) !== null) {
      const body = balanced(window, m.index + s.index + s[0].length - 1 - m.index);
      if (body === null) continue;

      for (const pair of topLevelPairs(body)) {
        const kv =
          /^\s*(?:\.\.\.\([^?]*\?\s*\{\s*)?["'`]?([a-z_][\w]*)["'`]?\s*:\s*([\s\S]+)$/i.exec(pair);
        if (!kv) continue;
        const column = kv[1]!.toLowerCase();
        if (!cols.has(column)) continue;

        const value = kv[2]!.trim();
        let form: string | null = null;
        /**
         * Anywhere in the value, not anchored at its start.
         *
         * `^JSON\.stringify` matched the plain case and nothing else. Planted
         * 2026-09-04, both of these stayed green on a jsonb column:
         *
         *   trigger_config: v ? JSON.stringify(v) : null
         *   trigger_config: JSON.stringify(v) as never   ← this one was caught,
         *                                                  the ternary was not
         *
         * A conditional is the ordinary way to write a nullable jsonb column, so
         * the miss sat directly on the common shape rather than on an exotic one.
         *
         * `::text::jsonb` is excluded because that IS the correct binding —
         * `toJsonb` is `${…}::text::jsonb`, and someone inlining it by hand is
         * right, not wrong. Without that carve-out, widening the search would
         * have started failing correct code, which is the other way to lose a
         * gate.
         */
        const STRINGIFY = /\bJSON\.stringify\s*\(/;
        const CORRECT_CAST = /::\s*text\s*::\s*jsonb/;
        if (STRINGIFY.test(value) && !CORRECT_CAST.test(value)) form = 'JSON.stringify(…)';
        else if (/^sql`\s*\$\{\s*JSON\.stringify[\s\S]*?\}\s*::\s*jsonb\s*`/.test(value))
          // Assembled rather than written whole: a literal `${…}` in a string
          // trips `noTemplateCurlyInString`, and that rule is right — it exists
          // to catch an interpolation somebody forgot to make a template. Here
          // the text IS the wrong form, being named. Same answer audit-gates.ts
          // reached for its probe bodies.
          form = `sql\`${INTERP_OPEN}JSON.stringify(…)}::jsonb\``;
        if (!form) continue;

        const abs = m.index + s.index;
        found.push({
          file: relative(ROOT, file),
          line: src.slice(0, abs).split('\n').length,
          table: m[2]!,
          column,
          form,
        });
      }
    }
  }
  return found;
}

// ── Run ───────────────────────────────────────────────────────────

const jsonb = jsonbColumns();
if (jsonb.size === 0) {
  console.error('[jsonb-binding] FAIL — no jsonb columns found in any migration.');
  console.error('  That is not a clean tree, it is a broken scan: this gate would pass');
  console.error('  over any code at all. Check the migration paths.');
  process.exit(1);
}

/**
 * Production writers only — `.test.ts` is excluded.
 *
 * This was the one gate in its family that read test files; the other six all
 * skip them (`!e.includes('.test.')` in check-atomic-writes,
 * check-insert-schema-match, check-numeric-string-arithmetic and
 * check-tenant-table-on-pool, `!e.endsWith('.test.ts')` in
 * check-raw-sql-identifiers, and a skipped `tests` directory in
 * check-duplicate-rules and check-rule-interpreters).
 *
 * A test is not a writer, and the exclusion is not merely tidiness: a
 * regression test for THIS defect has to write the wrong shape on purpose in
 * order to assert that PostgreSQL cannot read it. Without the exclusion, the
 * only honest test of the binding is one the gate refuses — and any fixture
 * anyone writes with `JSON.stringify` into a jsonb column trips the ratchet on a
 * tree with no production defect. Found on 2026-09-04 by exactly that: the
 * proof in `jsonb-notification-binding.test.ts` was reported as a violation.
 */
const isSource = (f: string) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('.test.');

const files: string[] = [];
for (const dir of ['packages/engine/src', 'packages/cli/src', 'packages/sdk/src']) {
  const p = join(ROOT, dir);
  if (existsSync(p)) walk(p, isSource, files);
}
if (existsSync(EXT_ROOT)) walk(EXT_ROOT, isSource, files);

// One site per file:line:table.column. The same object literal is reachable
// through more than one `.set(...)` match when a chain nests them, and counting
// it twice would make the baseline depend on how the chain is written.
const seen = new Set<string>();
const sites = files
  .flatMap((f) => scan(f, jsonb))
  .filter((s) => {
    const k = `${s.file}:${s.line}:${s.table}.${s.column}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

// Keyed by table.column so the baseline stays stable when a file moves.
const counts: Record<string, number> = {};
for (const s of sites) {
  const key = `${s.table}.${s.column}`;
  counts[key] = (counts[key] ?? 0) + 1;
}

if (REPORT) {
  console.log(`[jsonb-binding] ${jsonb.size} table(s) carry a jsonb column.`);
  if (sites.length === 0) console.log('  No JSON.stringify bound to one.');
  for (const s of sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.log(`  ${s.file}:${s.line}  ${s.table}.${s.column} ← ${s.form}`);
  }
  process.exit(0);
}

const baseline: { counts: Record<string, number> } = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8'))
  : { counts: {} };

if (UPDATE) {
  writeFileSync(
    BASELINE,
    `${JSON.stringify(
      {
        _what:
          'Columns declared jsonb whose writers bind JSON.stringify(...) instead of toJsonb(...). ' +
          "The value is stored as a jsonb STRING, so `col->>'k'` is NULL and `col ? 'k'` is false. " +
          'Counts may shrink, never grow.',
        _why_it_has_a_gate:
          'Four columns were found this way and repaired in 03515eb1, which shipped lib/jsonb.ts ' +
          'and no gate. A fifth site existed at the time — zvd_collections.fields, three writers — ' +
          'and nothing would have said so. Readers compensate, so the defect is silent until ' +
          'somebody writes the SQL that assumes the shape.',
        _how_to_fix: `Use \`toJsonb(value)\` from lib/jsonb.ts, which binds \`${INTERP_OPEN}…}::text::jsonb\`.`,
        _regenerate: 'bun run scripts/check-jsonb-binding.ts --update',
        counts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[jsonb-binding] baseline written — ${sites.length} site(s).`);
  process.exit(0);
}

const over: string[] = [];
for (const [key, n] of Object.entries(counts)) {
  const allowed = baseline.counts[key] ?? 0;
  if (n > allowed) over.push(`  ${key}: ${n} site(s), baseline allows ${allowed}`);
}

if (over.length > 0) {
  console.error('[jsonb-binding] FAIL — JSON.stringify bound to a jsonb column:\n');
  console.error(over.join('\n'));
  console.error('\n  A jsonb column bound this way stores a jsonb STRING containing JSON text.');
  console.error("  `col->>'k'` is NULL and `col ? 'k'` is false against it.");
  console.error('  Use `toJsonb(value)` from lib/jsonb.ts. Run with --report to see every site.');
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const allowed = Object.values(baseline.counts).reduce((a, b) => a + b, 0);
console.log(
  `[jsonb-binding] OK — ${total} site(s) across ${jsonb.size} table(s) with jsonb columns, baseline allows ${allowed}.`,
);
