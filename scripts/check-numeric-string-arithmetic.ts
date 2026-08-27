#!/usr/bin/env bun
/**
 * `+` on a column PostgreSQL sends as a string.
 *
 * `BIGINT`, `NUMERIC`, `DECIMAL` and every `COUNT`/`SUM`/`AVG` aggregate arrive
 * from Bun's driver as strings — it exposes no type-parser hook, so there is no
 * single place to fix this. The failure profile is the reason this needs a gate
 * rather than a code review: `-`, `*`, `/`, `<` and `>` all coerce and produce
 * the right answer. **Only `+` concatenates.** A module can be correct for a
 * year and then break the day someone adds a subtotal.
 *
 * What follows is worse than a wrong number. `"0" + "12.5"` is `"012.5"`, the
 * next operator turns that into `NaN`, PostgreSQL stores `NaN` in a `NUMERIC`
 * without complaint, and `NaN` compares as LARGER than every number — so the
 * poisoned row passes `WHERE balance > 0` and passes `CHECK (col >= 0)`. That is
 * how the leave module came to grant unlimited days: the guard ran and said yes.
 *
 * The detector reads the column list from a real database rather than parsing
 * migrations, and flags `x.col + …`, `… + x.col` and `total += x.col` where
 * `col` is one of them. It is deliberately syntactic and deliberately narrow: it
 * cannot see through a local variable, so a clean run is not proof. It catches
 * the shape that has produced every instance found so far.
 *
 * Usage:
 *   DATABASE_URL=postgres://… bun run scripts/check-numeric-string-arithmetic.ts
 *
 * Without a database it exits 0 with a note — the lanes that have one run it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SQL } from 'bun';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'quality-gates', 'numeric-string-arithmetic.json');
const EXT_DIR = join(ROOT, '..', 'zveltio-extensions');
const DIRS = [join(ROOT, 'packages'), EXT_DIR];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[numeric-arith] FAIL — no DATABASE_URL; this gate needs a live schema.');
  console.error('It used to exit 0 here. A gate that cannot run is not a gate that passed:');
  console.error('green meant "checked nothing" in three different ways, and nothing said so.');
  process.exit(1);
}

let columns: string[];
try {
  const sql = new SQL(url);
  const rows = await sql<{ column_name: string }[]>`
    SELECT DISTINCT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('bigint', 'numeric')`;
  columns = rows.map((r) => r.column_name);
  await sql.end();
} catch (err) {
  console.error(`[numeric-arith] FAIL — cannot reach the database (${(err as Error).message}).`);
  console.error('The column corpus comes from the live schema; without it nothing is checked.');
  process.exit(1);
}

if (columns.length === 0) {
  console.error('[numeric-arith] FAIL — the schema has no bigint/numeric columns.');
  console.error('Point DATABASE_URL at a migrated database with the extensions installed.');
  process.exit(1);
}

/**
 * Can this schema see the sites the baseline records?
 *
 * The patterns key on column names read from the live database, so the gate's
 * reach is whatever happens to be installed. On a core-only schema none of the
 * finance columns exist, every baselined site becomes invisible, and the run
 * ends `OK — 0 site(s), baseline allows 22`. Naming the columns the baseline
 * depends on turns that silence into a failure.
 */
const requiredColumns: string[] = (() => {
  if (!existsSync(BASELINE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>;
    const req = parsed._required_columns;
    return Array.isArray(req) ? req.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
})();

const present = new Set(columns);
const missingColumns = requiredColumns.filter((c) => !present.has(c));
if (missingColumns.length > 0) {
  console.error('[numeric-arith] FAIL — the schema is missing columns this gate keys on:\n');
  for (const c of missingColumns) console.error(`  ${c}`);
  console.error('\nThe baselined sites reference these, so a pass here would prove nothing.');
  console.error('Boot the engine against this database with ZVELTIO_EXTENSIONS_PATH set, so the');
  console.error('extension tables exist before the gate runs.');
  process.exit(1);
}

// Column names too generic to key on: `value`, `amount` and friends name a
// numeric column in one table and a plain string somewhere else, and the
// resulting noise is what gets a gate switched off.
const AMBIGUOUS = new Set(['value', 'id', 'size', 'total', 'count', 'rate', 'weight', 'score']);
const names = columns.filter((c) => !AMBIGUOUS.has(c) && c.length > 3);
const alt = names.map((n) => n.replace(/[^a-z0-9_]/gi, '')).join('|');

// A unary `+` is the fix, not the bug: `s + +row.amount` and `let p = +p.price`
// have already coerced. So each pattern excludes an operand that carries one,
// and excludes a `+` that is itself unary (preceded by `(`, `=`, `,`, an
// operator — anything that is not a value).
const VALUE_BEFORE = '(?<=[\\w)\\]\'"`]\\s{0,4})';

/**
 * The column list comes from the schema, so it flags any property that SHARES a
 * name with a numeric column — including ones that never went near the driver.
 * `+invoice.amount_paid + input.amount` was reported for its second operand:
 * `amount` is a NUMERIC column somewhere, and `input` is a caller's argument
 * typed `number`. The line was correct, and carried a comment saying why.
 *
 * The strings only arrive by way of a query, so an operand rooted at the
 * request or the argument bag is not one of them. These names are the ones this
 * codebase uses for that, and never for a row. Keep the list short: every entry
 * is a place the gate stops looking, and the doc above is honest that a clean
 * run was never proof.
 */
const NON_ROW_ROOT = /^(?:input|body|params|query|payload|args|opts|options|dto)$/i;
const rootOf = (path: string): string => path.split(/[.[\]?]/)[0] ?? '';

/**
 * `receivers` holds the group indices of the operands a pattern ACCUSES. The
 * finding is dropped when any one of them is rooted outside a row, which is the
 * right rule for all four: for `+` there is a single accused operand, and for a
 * comparison a non-row on either side means a number on that side, which
 * coerces — the reason this was framed as a `+`-only problem to begin with.
 */
const PATTERNS: { re: RegExp; why: string; receivers: number[] }[] = [
  {
    re: new RegExp(
      `(?<![+\\w.])([\\w\\[\\]?]+(?:\\.[\\w\\[\\]?]+)*)\\.(${alt})\\s*\\+(?!\\+|=)`,
      'i',
    ),
    why: 'numeric column on the left of a `+`',
    receivers: [1],
  },
  {
    re: new RegExp(`${VALUE_BEFORE}\\+\\s*(?!\\+)([\\w.\\[\\]?]*)\\.(${alt})\\b`, 'i'),
    why: 'numeric column on the right of a `+`',
    receivers: [1],
  },
  {
    re: new RegExp(`\\+=\\s*(?!\\+)([\\w.\\[\\]?]*)\\.(${alt})\\b`, 'i'),
    why: 'numeric column accumulated with `+=`',
    receivers: [1],
  },
  // A comparison with a NUMBER on one side coerces and is fine — that is why the
  // audit framed this as a `+`-only problem. With a STRING on BOTH sides it never
  // does: `"9.0000" >= "10.0000"` is true, lexicographically. `operations/inventory`
  // compared quantity_received against quantity_ordered that way and stamped a
  // partially-received purchase order as fully received, closing it so the
  // shortfall could never be recorded.
  {
    re: new RegExp(
      `([\\w.\\[\\]?]*)\\.(${alt})\\s*(?:>=|<=|>|<)\\s*(?!\\+)([\\w.\\[\\]?]*)\\.(${alt})\\b`,
      'i',
    ),
    why: 'two numeric columns compared directly — that is a string comparison',
    receivers: [1, 3],
  },
];
/**
 * Is this line inside an SQL template literal?
 *
 * `SET quantity = zvd_stock_levels.quantity + 1` is PostgreSQL doing the
 * addition, which is correct and is in fact the fix — the whole problem is that
 * the value leaves the database. Reporting those buries the JavaScript sites
 * that matter under noise from the ones already right.
 */
function sqlTemplateLines(src: string): Set<number> {
  const inside = new Set<number>();
  const lines = src.split('\n');
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (open) inside.add(i);
    let scan = line;
    if (!open) {
      const m = /\bsql(?:<[^>]*>)?\s*`/.exec(line);
      if (!m) continue;
      scan = line.slice(m.index + m[0].length);
      open = true;
      inside.add(i);
    }
    // A backtick closes it — the gate in check-sql-template-backticks.ts is what
    // keeps that assumption true.
    if (scan.includes('`')) open = false;
  }
  return inside;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e === 'coverage' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.d.ts') && !e.includes('.test.')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const findings: { key: string; detail: string }[] = [];
for (const dir of DIRS) {
  for (const file of tsFiles(dir)) {
    // Stable, machine-independent keys: the baseline is checked in, so it must
    // not carry anyone's home directory.
    const rel = file.startsWith(`${ROOT}/`)
      ? file.slice(ROOT.length + 1)
      : `ext:${file.slice(file.indexOf('zveltio-extensions/') + 'zveltio-extensions/'.length)}`;
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const inSql = sqlTemplateLines(src);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (inSql.has(i)) continue;
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      // A conversion on the line is the fix; do not report what is already fixed.
      if (/\btoNumber|\bNumber\(|parseFloat|parseInt|toNumberSafe|sumNumeric/.test(line)) continue;
      for (const { re, why, receivers } of PATTERNS) {
        const m = re.exec(line);
        if (!m) continue;
        if (receivers.some((g) => NON_ROW_ROOT.test(rootOf(m[g] ?? '')))) continue;
        findings.push({
          key: `${rel}`,
          detail: `${rel}:${i + 1}  ${why}\n      ${line.trim().slice(0, 100)}`,
        });
        break;
      }
    }
  }
}

/**
 * Keys beginning with `_` are prose, not counts — JSON has no comments and a
 * baseline nobody can read is a baseline nobody maintains.
 */
function readBaseline(): Record<string, number> {
  if (!existsSync(BASELINE)) return {};
  const raw = readFileSync(BASELINE, 'utf8').trim();
  if (raw === '') return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

const baseline = readBaseline();

/**
 * Is the gate even looking at the code it was calibrated against?
 *
 * Every key in the baseline names a file that had findings when it was recorded.
 * `tsFiles()` returns `[]` for a directory that is not there, so when the
 * extensions sibling is missing the scan quietly covers nothing and the run ends
 * with `OK — 0 site(s)`. That is what green looked like while the detector was
 * blind, and it is indistinguishable from a clean repository unless somebody
 * checks that the corpus is present. So: check.
 */
const missingCorpus = Object.keys(baseline).filter((key) => {
  const path = key.startsWith('ext:') ? join(EXT_DIR, key.slice('ext:'.length)) : join(ROOT, key);
  return !existsSync(path);
});

if (missingCorpus.length > 0) {
  console.error(
    '[numeric-arith] FAIL — the corpus this baseline was recorded against is missing:\n',
  );
  for (const key of missingCorpus) console.error(`  ${key}`);
  console.error('\nThe scan cannot have covered these files, so a pass here would mean nothing.');
  console.error(
    'Check out the zveltio-extensions sibling, or re-record the baseline without them.',
  );
  process.exit(1);
}

const counts: Record<string, number> = {};
for (const f of findings) counts[f.key] = (counts[f.key] ?? 0) + 1;

const regressions = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0));

if (regressions.length > 0) {
  console.error('[numeric-arith] FAIL — `+` on a column the driver returns as a string:\n');
  for (const [key] of regressions) {
    for (const f of findings.filter((x) => x.key === key)) console.error(`  ${f.detail}\n`);
  }
  console.error('Convert first: `toNumber(row.col)` from `lib/numeric.js`.');
  console.error('`-`, `*` and `/` working here is not evidence — they coerce; only `+` does not.');
  process.exit(1);
}

const total = findings.length;
const allowed = Object.values(baseline).reduce((a, b) => a + b, 0);

// The corpus files are on disk and the baseline says there are sites in them,
// yet the detector matched nothing. The patterns key on column names taken from
// the live schema, so the usual cause is a database without the extension tables
// — the same green-while-blind this gate exits 1 for above, arriving by a
// different road. If the sites were genuinely fixed, re-record the baseline.
if (allowed > 0 && total === 0) {
  console.error(
    `[numeric-arith] FAIL — baseline records ${allowed} site(s) and the scan found none.`,
  );
  console.error(
    'The files are present, so the column corpus is the suspect: point DATABASE_URL at',
  );
  console.error('a schema with the extension tables. If the sites really are fixed, edit');
  console.error('quality-gates/numeric-string-arithmetic.json down to the counts that remain.');
  process.exit(1);
}

console.log(`[numeric-arith] OK — ${total} site(s), baseline allows ${allowed}.`);
