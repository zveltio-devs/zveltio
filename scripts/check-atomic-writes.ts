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
 * WHAT COUNTS: a handler whose text CONTAINS two or more write forms —
 * `insertInto` / `updateTable` / `deleteFrom`, or raw `INSERT INTO` / `UPDATE x` /
 * `DELETE FROM` in a sql`` tag — and no `.transaction(`. Containing is not the
 * same as executing; see below.
 *
 * WHAT THIS CANNOT SEE, in BOTH directions — read the number as an approximation,
 * not a census:
 *
 *   - It misses a handler that calls a helper which writes. Those are undercounted.
 *   - It counts branches that cannot both run. `finance/invoicing` PUT /company is
 *     `existing ? UPDATE… : INSERT…` — one statement executes, ever, and there is
 *     nothing to make atomic. The detector sees two write keywords and flags it.
 *
 * Both were found by reading the flagged code rather than trusting the count, and
 * that is how a finding here is meant to be used: it says "look", not "fix". A
 * reviewer decides which kind it is, and records the exclusive ones with --update.
 *
 * Separating branches properly needs a parser, not a regex. That is a reasonable
 * next step and deliberately not attempted here — a gate that is honest about
 * being approximate is more useful than one that is quietly wrong.
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
/** Print each flagged handler instead of per-file totals. Optionally filtered by
 *  a path substring: `--list hr/employees`. The baseline records counts, which is
 *  all a gate needs, but fixing one means knowing WHICH handler is flagged. */
const LIST = process.argv.includes('--list');
const LIST_FILTER = LIST ? (process.argv[process.argv.indexOf('--list') + 1] ?? '') : '';

/**
 * `DO UPDATE` is excluded, and that is not a nicety.
 *
 * `INSERT … ON CONFLICT … DO UPDATE SET …` is ONE statement — an upsert, atomic
 * by construction. Counting its `UPDATE` as a second write made every upsert in
 * the codebase look like a handler that needed a transaction, which was the
 * largest single source of noise in the first run of this gate: 40 handlers
 * landed in a "possible upsert" pile that mostly could not fail halfway.
 *
 * `\bDO\s+UPDATE` is checked first so the alternation cannot fall through to the
 * bare `UPDATE` branch.
 */
const WRITE =
  /\bDO\s+UPDATE\b|\b(insertInto|updateTable|deleteFrom)\s*\(|\bINSERT\s+INTO\b|\bUPDATE\s+["\w]|\bDELETE\s+FROM\b/gi;

/** Matches of `WRITE` that are real writes — `DO UPDATE` is part of an upsert. */
function countWrites(text: string): number {
  WRITE.lastIndex = 0;
  return (text.match(WRITE) ?? []).filter((m) => !/^DO\s+UPDATE$/i.test(m.trim())).length;
}
/**
 * Split points: a route registration, OR a named function declaration.
 *
 * The function half matters. A helper declared BETWEEN two registrations — the
 * common `async function saveSettings(c)` shared by `app.post` and `app.put` —
 * used to be swallowed into the preceding handler's slice, so its writes were
 * reported against whichever route happened to be above it. That named a route
 * that does not write at all (`GET /settings` in the e-Factura module) and hid
 * the one that does, which for a gate meant to point at work is worse than not
 * flagging it: the reader goes to the named handler, finds nothing, and learns
 * to distrust the list.
 */
const HANDLER_SPLIT =
  /(?=(?:app|router)\.(?:get|post|put|patch|delete)\s*\(|^[ \t]*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\()/m;
const HANDLER_NAME = /^(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]*)/i;
const FUNCTION_NAME = /^[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;

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
    const writes = countWrites(part);
    if (writes < 2) continue;
    if (/\.transaction\s*\(/.test(part)) continue;
    const m = HANDLER_NAME.exec(part);
    const fn = m ? null : FUNCTION_NAME.exec(part);
    out.push({
      file: label,
      handler: m ? `${m[1].toUpperCase()} ${m[2] || '/'}` : fn ? `${fn[1]}()` : '(unnamed)',
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

if (LIST) {
  const shown = findings.filter(
    (f) => !LIST_FILTER || LIST_FILTER.startsWith('--') || f.file.includes(LIST_FILTER),
  );
  let current = '';
  for (const f of shown.sort((a, b) => a.file.localeCompare(b.file))) {
    if (f.file !== current) {
      current = f.file;
      console.log(`\n${current}`);
    }
    console.log(`  ${String(f.writes).padStart(2)} writes  ${f.handler}`);
  }
  console.log(`\n[atomic-writes] ${shown.length} handler(s) listed.`);
  process.exit(0);
}

const counts: Record<string, number> = {};
for (const f of findings) counts[f.file] = (counts[f.file] ?? 0) + 1;

/** Reviewer notes from the current baseline, carried across a --update. */
const existingReasons: Record<string, string> = existsSync(BASELINE)
  ? (((JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, unknown>)._reasons as Record<
      string,
      string
    >) ?? {})
  : {};

if (UPDATE) {
  const doc = {
    _what:
      'Handlers performing two or more writes with no explicit transaction. They are atomic only because tenantMiddleware wraps the whole request in one — a property they never asked for.',
    _why_this_matters:
      'That transaction exists for ISOLATION (SET LOCAL ROLE + the tenant GUC). Atomicity is a side effect of where its boundary sits. Moving the boundary — which the concurrency ceiling requires — turns each of these into a silent partial write.',
    _how_to_fix:
      'Wrap the handler body in db.transaction().execute(async (trx) => …) and use trx for every write. Then remove the file from this list.',
    _regenerate: 'bun run scripts/check-atomic-writes.ts --update',
    _reasons_are_preserved:
      "Entries under _reasons survive --update. A file listed there is one a reviewer has looked at and decided does NOT need wrapping — helpers that run inside a caller's transaction, or branches that are mutually exclusive so only one write ever executes. The count still has to match, so a NEW write in such a file still fails the gate.",
    _reasons: existingReasons,
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
