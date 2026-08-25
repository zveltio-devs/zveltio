#!/usr/bin/env bun
/**
 * A handler that writes twice should say so.
 *
 * Today it does not have to. `tenantMiddleware` runs the whole request inside
 * one transaction — that is how `SET LOCAL ROLE` enforces RLS — so a handler
 * doing two writes gets atomicity it never asked for. If the second fails, the
 * first rolls back, and nobody wrote a line of code to make that true.
 *
 * That is exactly why it is fragile. The transaction exists for ISOLATION;
 * atomicity is a side effect of where its boundary happens to sit. Moving that
 * boundary — which the concurrency ceiling eventually requires, because a
 * connection pinned for a whole request cannot serve thousands of them — would
 * silently turn every one of these into a partial write. No test fails, no error
 * is logged; one day an invoice has a header and no lines.
 *
 * So the ones that rely on it are recorded here, and new ones are refused. Then
 * the boundary can move against a list rather than a hope.
 *
 * WHAT COUNTS as a write: `insertInto` / `updateTable` / `deleteFrom`, and raw
 * `INSERT INTO` / `UPDATE x` / `DELETE FROM` in a sql`` tag. Two or more of them
 * in one handler, with no `.transaction(` anywhere in that handler, is a finding.
 *
 * WHAT THIS CANNOT SEE: a handler that calls a helper which writes. The count is
 * therefore a floor, not a census — which is the honest way to read it, and the
 * reason the baseline is per-file rather than a single total.
 *
 * Usage:
 *   bun run scripts/check-atomic-writes.ts            # gate
 *   bun run scripts/check-atomic-writes.ts --update   # re-record the baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
const BASELINE = join(ROOT, 'quality-gates', 'atomic-writes.json');
const UPDATE = process.argv.includes('--update');

const WRITE =
  /\b(insertInto|updateTable|deleteFrom)\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+["\w]|\bDELETE\s+FROM\b/gi;
const HANDLER_SPLIT = /(?=(?:app|router)\.(?:get|post|put|patch|delete)\s*\()/;
const HANDLER_NAME = /^(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]*)/i;

/** Line comments and block comments removed, so prose about SQL is not SQL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function tsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (e.endsWith('.ts') && !e.includes('.test.')) out.push(p);
  }
  return out;
}

interface Finding {
  file: string;
  handler: string;
  writes: number;
}

function scan(file: string, label: string): Finding[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const out: Finding[] = [];
  for (const part of src.split(HANDLER_SPLIT).slice(1)) {
    WRITE.lastIndex = 0;
    const writes = (part.match(WRITE) ?? []).length;
    if (writes < 2) continue;
    if (/\.transaction\s*\(/.test(part)) continue;
    const m = HANDLER_NAME.exec(part);
    out.push({
      file: label,
      handler: m ? `${m[1].toUpperCase()} ${m[2] || '/'}` : '(unnamed)',
      writes,
    });
  }
  return out;
}

const findings: Finding[] = [];
for (const f of tsFiles(join(ROOT, 'packages', 'engine', 'src', 'routes'))) {
  findings.push(...scan(f, relative(ROOT, f)));
}
if (existsSync(EXT_ROOT)) {
  for (const f of tsFiles(EXT_ROOT)) {
    if (!f.includes('/engine/')) continue;
    findings.push(...scan(f, `ext:${relative(EXT_ROOT, f)}`));
  }
} else {
  console.log('[atomic-writes] sibling zveltio-extensions absent — engine only.');
}

const counts: Record<string, number> = {};
for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1;

if (UPDATE) {
  const doc = {
    _what:
      'Handlers performing two or more writes with no explicit transaction. They are atomic only because tenantMiddleware wraps the whole request in one — a property they never asked for.',
    _why_this_matters:
      'That transaction exists for ISOLATION (SET LOCAL ROLE + the tenant GUC). Atomicity is a side effect of where its boundary sits. Moving the boundary — which the concurrency ceiling requires — turns each of these into a silent partial write.',
    _how_to_fix:
      'Wrap the handler body in db.transaction().execute(async (trx) => …) and use trx for every write. Then remove the file from this list.',
    _regenerate: 'bun run scripts/check-atomic-writes.ts --update',
    ...Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(BASELINE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `[atomic-writes] recorded ${findings.length} handler(s) across ${Object.keys(counts).length} file(s).`,
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('[atomic-writes] no baseline — run with --update.');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number | string>;
const regressions: string[] = [];
for (const [file, n] of Object.entries(counts)) {
  const allowed = typeof baseline[file] === 'number' ? (baseline[file] as number) : 0;
  if (n > allowed) regressions.push(`  ${file}: ${allowed} → ${n}  (+${n - allowed})`);
}

if (regressions.length > 0) {
  console.error('\n❌ New handlers write more than once without an explicit transaction:\n');
  for (const r of regressions) console.error(r);
  console.error(
    '\n  Wrap the writes in `db.transaction()`. They look atomic today only because the\n' +
      '  tenant transaction happens to span the request, and that boundary is moving.\n' +
      '  If the handler genuinely does not need atomicity, record it with --update and\n' +
      '  say why in review.\n',
  );
  process.exit(1);
}

const improvements = Object.entries(baseline)
  .filter(([k, v]) => typeof v === 'number' && (counts[k] ?? 0) < (v as number))
  .map(([k, v]) => `  ${k}: ${v} → ${counts[k] ?? 0}`);
if (improvements.length > 0) {
  console.log('[atomic-writes] improvements:');
  for (const i of improvements) console.log(i);
}
console.log(`[atomic-writes] OK — ${findings.length} handler(s) on the baseline, none above it.`);
