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
const DIRS = [join(ROOT, 'packages'), join(ROOT, '..', 'zveltio-extensions')];

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('[numeric-arith] SKIP — no DATABASE_URL; this gate needs a live schema.');
  process.exit(0);
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
  console.log(`[numeric-arith] SKIP — cannot reach the database (${(err as Error).message}).`);
  process.exit(0);
}

if (columns.length === 0) {
  console.log('[numeric-arith] SKIP — the schema has no bigint/numeric columns yet.');
  process.exit(0);
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
const PATTERNS: [RegExp, string][] = [
  [
    new RegExp(`(?<![+\\w.])[\\w\\[\\]?]+(?:\\.[\\w\\[\\]?]+)*\\.(${alt})\\s*\\+(?!\\+|=)`, 'i'),
    'numeric column on the left of a `+`',
  ],
  [
    new RegExp(`${VALUE_BEFORE}\\+\\s*(?!\\+)[\\w.\\[\\]?]*\\.(${alt})\\b`, 'i'),
    'numeric column on the right of a `+`',
  ],
  [
    new RegExp(`\\+=\\s*(?!\\+)[\\w.\\[\\]?]*\\.(${alt})\\b`, 'i'),
    'numeric column accumulated with `+=`',
  ],
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
      for (const [re, why] of PATTERNS) {
        if (re.test(line)) {
          findings.push({
            key: `${rel}`,
            detail: `${rel}:${i + 1}  ${why}\n      ${line.trim().slice(0, 100)}`,
          });
          break;
        }
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
console.log(`[numeric-arith] OK — ${total} site(s), baseline allows ${allowed}.`);
