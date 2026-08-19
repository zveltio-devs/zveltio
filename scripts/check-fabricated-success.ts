#!/usr/bin/env bun
/**
 * A `.catch` that invents a successful-looking answer.
 *
 * The audit of this engine put it plainly: **sixteen of its twenty defects are
 * one shape — a failure that renders as a success.** Not a crash, not a wrong
 * number a reader would question, but a value indistinguishable from the answer
 * you get when everything worked:
 *
 *   .catch(() => ({ rows: [{ total: '0' }] }))   the data-quality scan could not
 *                                                count the table, so it reported
 *                                                a clean bill of health
 *   .catch(() => null)                           validation could not run, so the
 *                                                write went through unvalidated
 *   .catch(() => ({ rows: [] }))                 the D300 VAT query failed, so the
 *                                                declaration was filed empty
 *   .catch(() => [])                             the junction-table lookup failed,
 *                                                so "there are none" — then the
 *                                                only record of them was deleted
 *
 * Each of those was written to keep something working. Each converted a loud
 * failure into a quiet wrong answer, which is the trade that looks good in the
 * diff and bad in production.
 *
 * `.catch(() => {})` and `.catch(() => undefined)` are NOT flagged: discarding a
 * result nobody reads — a fire-and-forget metric, a best-effort cleanup — says
 * "this did not matter", which is a different statement from "this succeeded".
 * Nor is a `.catch` with a real body, which is a decision someone wrote down.
 *
 * The list is a ratchet: counts may shrink, never grow. Every entry in the
 * baseline was read once; a NEW one is a decision nobody has reviewed.
 *
 * Usage:
 *   bun run scripts/check-fabricated-success.ts [--list]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'quality-gates', 'fabricated-success.json');
const DIRS = [join(ROOT, 'packages'), join(ROOT, '..', 'zveltio-extensions')];

/**
 * Where the engine INSTALLS extensions at runtime.
 *
 * Gitignored, populated by whatever a developer happened to install, and a
 * verbatim copy of source this gate already scans in `zveltio-extensions`. It
 * was contributing 23 sites across 6 files — the same `.catch` handlers counted
 * a second time under a second path — so the baseline recorded a number that
 * depended on one machine's install state, and fixing a site in the extensions
 * repo could not clear its twin here until someone reinstalled.
 */
const RUNTIME_INSTALL_DIR = join(ROOT, 'packages', 'engine', 'extensions');
const LIST = process.argv.includes('--list');

/**
 * A one-expression catch handler returning something that reads as data.
 *
 * `\(\s*\w*\s*\)` allows `.catch(() => …)` and `.catch((e) => …)`. The value must
 * open with `{`, `[`, `(`, a digit, a quote, `null`, `true` or `false` — a
 * fabricated result rather than a rethrow or a statement block.
 */
const FABRICATED =
  /\.catch\(\s*(?:async\s*)?\(\s*\w*\s*(?::[^)]*)?\)\s*=>\s*(\(|\{\s*\w|\[|null\b|true\b|false\b|\d|'|"|`)/;

/** `.catch(() => {})`, `.catch(() => undefined)` — discarding, not inventing. */
const DISCARDING =
  /\.catch\(\s*(?:async\s*)?\(\s*\w*\s*(?::[^)]*)?\)\s*=>\s*(\{\s*\}|undefined\b|void\b)/;

/**
 * Scoped to DATABASE calls, deliberately.
 *
 * Running the pattern over everything returns ~600 sites, almost all of them
 * `await c.req.json().catch(() => ({}))` or `res.json().catch(() => ({}))` —
 * "the body was not JSON", which is a true statement about a request, not an
 * invented answer about the world. A gate that reports six hundred things is a
 * gate somebody switches off.
 *
 * Every instance the audit actually found was a query: `.execute(db)`,
 * `.executeTakeFirst()`, `sql\`…\``. That is the population this watches, and it
 * looks back a few lines because the idiomatic spelling puts `.execute(db)` and
 * `.catch(...)` on separate lines.
 */
const QUERY_CALL =
  /\.execute\(|\.executeTakeFirst\(|\.executeTakeFirstOrThrow\(|\bsql`|\bsql<|\bsql\.raw\(/;
const LOOKBACK = 4;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e === 'coverage' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (p === RUNTIME_INSTALL_DIR) continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && !e.endsWith('.d.ts') && !e.includes('.test.')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

interface Finding {
  key: string;
  line: number;
  text: string;
}

const findings: Finding[] = [];
for (const dir of DIRS) {
  for (const file of tsFiles(dir)) {
    const key = file.startsWith(`${ROOT}/`)
      ? file.slice(ROOT.length + 1)
      : `ext:${file.slice(file.indexOf('zveltio-extensions/') + 'zveltio-extensions/'.length)}`;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      if (DISCARDING.test(line)) continue;
      if (!FABRICATED.test(line)) continue;
      // The catch must belong to the query, not merely live near one. Either the
      // same line performs it (`await q.execute(db).catch(...)`), or the line IS
      // the continuation of a query chain — a bare `.catch(` under an `.execute(`.
      // Without this, a `c.req.json().catch(() => ({}))` anywhere in a file that
      // also runs SQL was reported, which took the count from 30 to 259 and would
      // have made the gate worthless.
      const sameLine = QUERY_CALL.test(line);
      const chained =
        t.startsWith('.catch(') &&
        QUERY_CALL.test(lines.slice(Math.max(0, i - LOOKBACK), i).join('\n'));
      if (!sameLine && !chained) continue;
      findings.push({ key, line: i + 1, text: t.slice(0, 100) });
    }
  }
}

function readBaseline(): Record<string, number> {
  if (!existsSync(BASELINE)) return {};
  const raw = readFileSync(BASELINE, 'utf8').trim();
  if (raw === '') return {};
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('_') && typeof v === 'number') out[k] = v;
  }
  return out;
}

const baseline = readBaseline();
const counts: Record<string, number> = {};
for (const f of findings) counts[f.key] = (counts[f.key] ?? 0) + 1;

if (LIST) {
  for (const f of findings) console.log(`${f.key}:${f.line}  ${f.text}`);
}

const regressions = Object.entries(counts).filter(([k, n]) => n > (baseline[k] ?? 0));
if (regressions.length > 0) {
  console.error('[fabricated-success] FAIL — a `.catch` that invents a successful answer:\n');
  for (const [key] of regressions) {
    for (const f of findings.filter((x) => x.key === key)) {
      console.error(`  ${f.key}:${f.line}\n      ${f.text}`);
    }
  }
  console.error(
    '\nA failure that renders as a success is the shape sixteen of twenty defects in this\n' +
      'engine shared. Let it throw, or return a value the caller can tell apart from data.\n' +
      '`.catch(() => {})` is fine where the result genuinely does not matter.',
  );
  process.exit(1);
}

const allowed = Object.values(baseline).reduce((a, b) => a + b, 0);
console.log(`[fabricated-success] OK — ${findings.length} site(s), baseline allows ${allowed}.`);
