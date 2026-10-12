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
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const BASELINE = join(ROOT, 'quality-gates', 'fabricated-success.json');
const DIRS = [join(ROOT, 'packages'), SIBLING_ROOT];
requireSibling(SIBLING_ROOT, 'fabricated-success');
import { SIBLING_ROOT, requireSibling } from './lib/require-sibling.js';

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
 * Scoped to DATABASE calls, deliberately.
 *
 * Running the check over every `.catch` returns ~600 sites, almost all of them
 * `await c.req.json().catch(() => ({}))` or `res.json().catch(() => ({}))` —
 * "the body was not JSON", which is a true statement about a request, not an
 * invented answer about the world. A gate that reports six hundred things is a
 * gate somebody switches off.
 *
 * Every instance the audit actually found was a query: `.execute(db)`,
 * `.executeTakeFirst()`, `sql\`…\``. That is the population this watches.
 */
const QUERY_CALL =
  /\.execute\(|\.executeTakeFirst\(|\.executeTakeFirstOrThrow\(|\bsql`|\bsql<|\bsql\.raw\(/;

/**
 * Read on the syntax tree, not on lines.
 *
 * The first version matched one line with a regex and looked FOUR lines back for
 * the query. The E02 review measured what that missed: a `.catch(() => [])` five
 * lines below its `.execute(` — a `.then(…)` body in between is enough — and a
 * handler extracted to a name, `.catch(emptyRows)`, which the inline-arrow
 * pattern could not see at all. Here the query is looked for in the whole
 * receiver of the `.catch`, however many lines it spans, and a named handler is
 * followed to its declaration in the same file.
 */
type Decls = Map<string, ts.Node>;

/** The value a handler hands back — data-shaped means invented. */
function fabricated(e: ts.Expression, decls: Decls, depth = 0): boolean {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAwaitExpression(e)
  ) {
    e = e.expression;
  }
  if (
    ts.isArrayLiteralExpression(e) ||
    ts.isObjectLiteralExpression(e) ||
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isTemplateExpression(e)
  ) {
    return true;
  }
  const k = e.kind;
  if (k === ts.SyntaxKind.NullKeyword || k === ts.SyntaxKind.TrueKeyword) return true;
  if (k === ts.SyntaxKind.FalseKeyword) return true;
  // `() => EMPTY` where `const EMPTY = { rows: [] }` — the same value, one name away.
  if (ts.isIdentifier(e) && depth < 3) {
    const d = decls.get(e.text);
    if (d && ts.isVariableDeclaration(d) && d.initializer && !isFn(d.initializer)) {
      return fabricated(d.initializer, decls, depth + 1);
    }
  }
  return false;
}

function isFn(n: ts.Node): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

/**
 * Does this handler invent an answer?
 *
 * `() => {}` and `() => undefined` discard; a block that does anything besides
 * return a value is "a decision someone wrote down" and is left alone. A block
 * that is ONLY `return []` is the arrow form with braces, and is flagged.
 */
function handlerFabricates(h: ts.Node, decls: Decls, depth = 0): boolean {
  if (ts.isIdentifier(h) && depth < 3) {
    const d = decls.get(h.text);
    if (!d) return false; // ponytail: imported handlers are not followed; same-file only
    if (ts.isFunctionDeclaration(d)) return handlerFabricates(d, decls, depth + 1);
    if (ts.isVariableDeclaration(d) && d.initializer) {
      return handlerFabricates(d.initializer, decls, depth + 1);
    }
    return false;
  }
  if (!isFn(h) || !h.body) return false;
  if (!ts.isBlock(h.body)) return fabricated(h.body, decls);
  const [only, ...rest] = h.body.statements;
  return (
    rest.length === 0 &&
    only !== undefined &&
    ts.isReturnStatement(only) &&
    only.expression !== undefined &&
    fabricated(only.expression, decls)
  );
}

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

/** `// fabricated-ok: <reason>` — reviewed and deliberately kept. Reason required. */
const REVIEWED_OK = /^\s*\/\/\s*fabricated-ok:\s*\S/;

const findings: Finding[] = [];
for (const dir of DIRS) {
  for (const file of tsFiles(dir)) {
    const key = file.startsWith(`${ROOT}/`)
      ? file.slice(ROOT.length + 1)
      : `ext:${file.slice(file.indexOf('zveltio-extensions/') + 'zveltio-extensions/'.length)}`;
    const src = readFileSync(file, 'utf8');
    if (!src.includes('.catch')) continue;
    const lines = src.split('\n');
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // Every named function and variable in the file, for `.catch(fallback)`.
    const decls: Decls = new Map();
    const catches: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name) {
        if (ts.isIdentifier(n.name)) decls.set(n.name.text, n);
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'catch' &&
        n.arguments.length > 0
      ) {
        catches.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const call of catches) {
      const pae = call.expression as ts.PropertyAccessExpression;
      // The catch must belong to the query: the query is somewhere in what it is
      // chained onto, however many lines that spans. Without this, a
      // `c.req.json().catch(() => ({}))` anywhere in a file that also runs SQL was
      // reported, which took the count from 30 to 259.
      if (!QUERY_CALL.test(pae.expression.getText(sf))) continue;
      if (!handlerFabricates(call.arguments[0]!, decls)) continue;
      const i = sf.getLineAndCharacterOfPosition(pae.name.getStart(sf)).line;
      // `// fabricated-ok: <reason>` on the line above marks a site that WAS reviewed
      // and deliberately kept — a fallback that states something true, like a health
      // check answering "disconnected" because the database is, or a guard whose
      // fabricated value is the refusing one. Without this the baseline cannot tell
      // those apart from the ones nobody has looked at, and a number that mixes the
      // two stops meaning anything.
      //
      // The reason is required and is not decoration: it is what the next person reads
      // instead of re-deriving the judgement.
      if (REVIEWED_OK.test(lines[i - 1] ?? '')) continue;
      findings.push({ key, line: i + 1, text: lines[i]!.trim().slice(0, 100) });
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
