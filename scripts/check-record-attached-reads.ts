#!/usr/bin/env bun
/**
 * A route that touches a record-attached table asks whether the record is
 * readable first (roadmap R2, short term).
 *
 * A record-attached table is keyed by `(collection, record_id)`: comments,
 * revisions, anything "about a record". Its rows must be as visible as the
 * record they hang off. E-1 was exactly this: record comments answered to the
 * tenant and nothing else, so a member who could not read a record read its
 * discussion. #900 added `recordReadable` — the record's own read gate: the
 * collection permission, the row rules, entity access — and moved the comment
 * routes onto it. This keeps the next route from forgetting.
 *
 * The rule, per file under `packages/engine/src/routes/`: a query on a
 * record-attached table (builder or SQL text) needs `recordReadable(` in the
 * same file, or a `// record-attached-ok: <reason>` comment on one of the three
 * lines above the reference — for a route whose reader may see every record
 * anyway (an instance-admin view), said out loud where a reviewer reads it.
 *
 * Which tables: read from the migrations, not listed here. Any table created
 * with both a `collection…` column and a `record_id` column counts, so the next
 * one is covered the day it is created. Finding none is a failure — a gate that
 * cannot see what it guards must not report clean.
 *
 * The long-term answer is in the database (a policy with EXISTS on the parent
 * row); this is the gate until then.
 *
 * Usage:
 *   bun run scripts/check-record-attached-reads.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const MIGRATIONS = join(ROOT, 'packages/engine/src/db/migrations/sql');
const ROUTES = join(ROOT, 'packages/engine/src/routes');

function recordAttachedTables(): string[] {
  const tables = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql'))) {
    const src = readFileSync(join(MIGRATIONS, f), 'utf8');
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const body = m[2] ?? '';
      if (/^\s*record_id\s/m.test(body) && /^\s*collection\w*\s/m.test(body)) tables.add(m[1]!);
    }
  }
  return [...tables].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const tables = recordAttachedTables();
if (tables.length === 0) {
  console.error('✗ record-attached-reads: no record-attached table found in the migrations —');
  console.error('  the gate cannot see what it guards. Check the CREATE TABLE pattern.');
  process.exit(1);
}

/**
 * The source with its comments blanked, line structure kept. A helper name or
 * `recordReadable(` written in a comment is not a call: it used to count as one,
 * so a route whose only "gate" was a sentence about it passed. `//` after a `:`
 * or a quote is left alone — that is a URL in a string, not a comment.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Names of the file's own helpers that ask `recordReadable` (`commentGate`):
 * calling one is asking the gate.
 */
function gateHelpers(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(
    /(?:const|function)\s+(\w+)\s*=?\s*(?:async\s*)?(?:function\s*)?\(/g,
  )) {
    const start = m.index ?? 0;
    const body = code.slice(start, start + 2000);
    const end = body.search(/\n\s{0,2}\};?\n/);
    if ((end === -1 ? body : body.slice(0, end)).includes('recordReadable(')) names.push(m[1]!);
  }
  return names;
}

const METHODS = 'get|post|put|patch|delete|all|on|use';

/**
 * Where a route (or a middleware) starts: `<router>.<method>(` for every name
 * the file binds to a Hono app — `new Hono(` or a `: Hono` parameter, so
 * `admin.get(` counts as surely as `app.get(` — or a chained `.get(` opening
 * its line. `app.use` counts: a middleware that reads the table is a route too.
 */
function routeStart(code: string): RegExp {
  const routers = new Set(['app', 'router', 'r']);
  for (const m of code.matchAll(/\b(\w+)\s*(?::\s*Hono\b|=\s*new\s+Hono\b)/g)) routers.add(m[1]!);
  return new RegExp(
    String.raw`\b(?:${[...routers].join('|')})\s*\.(?:${METHODS})\(|^\s*\.(?:${METHODS})\(`,
  );
}

const violations: string[] = [];
for (const file of walk(ROUTES)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const code = stripComments(src).split('\n');
  const ROUTE_START = routeStart(code.join('\n'));
  // Per route, not per file: one gated handler used to clear every other
  // handler in the file, and a DELETE that skipped the gate went unseen.
  const gate = new RegExp(
    String.raw`\b(?:${['recordReadable', ...gateHelpers(code.join('\n'))].join('|')})\(`,
  );
  // The route the line is in: from its start to the next one. A lookup that
  // finds which record to ask about comes before the ask, so anywhere in the
  // route counts.
  const gatedInRoute = (i: number): boolean => {
    let start = i;
    while (start > 0 && !ROUTE_START.test(code[start]!)) start--;
    if (!ROUTE_START.test(code[start]!)) return false;
    let end = i + 1;
    while (end < code.length && !ROUTE_START.test(code[end]!)) end++;
    return gate.test(code.slice(start, end).join('\n'));
  };
  for (const table of tables) {
    const use = new RegExp(
      String.raw`(?:selectFrom|updateTable|deleteFrom|insertInto|innerJoin|leftJoin|rightJoin|\bjoin)\(\s*['"\`]${table}\b|\b(?:FROM|JOIN|INTO|UPDATE)\s+"?${table}\b`,
      'i',
    );
    code.forEach((line, i) => {
      if (!use.test(line)) return;
      // The waiver is a comment, so it is read from the original lines.
      const above = lines.slice(Math.max(0, i - 3), i).join('\n');
      if (/\/\/\s*record-attached-ok:\s*\S/.test(above)) return;
      if (gatedInRoute(i)) return;
      violations.push(`  ${relative(ROOT, file)}:${i + 1}  ${table}  ${line.trim().slice(0, 100)}`);
    });
  }
}

if (violations.length > 0) {
  console.error(
    `✗ record-attached-reads: ${violations.length} query(ies) on a record-attached table`,
  );
  console.error('  with no recordReadable() in its route:\n');
  for (const v of violations) console.error(v);
  console.error(
    '\nAsk recordReadable(db, reqDb, collection, recordId, user, authType) before reading or\n' +
      'writing the row, or — for a reader who may see every record — mark the line with\n' +
      '`// record-attached-ok: <why>` on one of the three lines above it.',
  );
  process.exit(1);
}
console.log(
  `✓ record-attached-reads: ${tables.length} record-attached table(s) (${tables.join(', ')}); every route reference is gated`,
);
