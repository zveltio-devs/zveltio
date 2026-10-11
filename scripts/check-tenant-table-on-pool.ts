#!/usr/bin/env bun
/**
 * A route handler must not query a tenant-scoped table on `poolDb`.
 *
 * Routers are handed TWO database handles, and the difference is the whole
 * point: `registerCoreRoutes(app, { db: scopedDb, poolDb: db, auth })`. The
 * `db` a route receives is `createRequestScopedDb` — a proxy that resolves the
 * request's transaction per access, so `db.selectFrom(...)` is already bound by
 * the tenant policies. `poolDb` is the raw pool, running as the engine's own
 * role, and a tenant-scoped query on it sees every tenant's rows.
 *
 * Scope: `routes/` only, and that boundary is a finding rather than an oversight.
 * Extending it to `lib/` was tried and reverted. There, the unscoped handle is
 * spelled `db` — the same name a transaction is passed under — so the gate either
 * catches nothing (matching only `poolDb`, which `lib/` does not use) or drowns in
 * false positives (matching `db`, which is usually the request transaction). The
 * first version of the extension took the harmless option and shipped four
 * "reviewed exceptions" for violations that could never fire. A gate whose
 * exception list is the only thing it produces is worse than no gate.
 *
 * The background access it would have covered is real and was inventoried:
 * `repairUnsignedWebhooksAtBoot` reads every tenant's webhooks; `flow-executor`
 * looks up a flow's tenant in order to learn which one to run as; the boot
 * reconciles walk every tenant's tables. All of them need to see across tenants by
 * design, which is why the engine's own role is not restricted.
 *
 * `poolDb` exists for good reasons — the four routers in `TXN_SKIP_PREFIXES`
 * would otherwise pin one connection and reach for a second, which deadlocks at
 * a concurrency equal to the pool size. This gate does not object to `poolDb`.
 * It objects to `poolDb` plus a table that carries a tenant.
 *
 * The first version of this gate had the premise backwards: it flagged `db.`,
 * on the belief that a route's `db` was the raw pool. It reported three
 * findings, all of them correct code, and one was waved through with a baseline
 * entry — a gate that excuses the right pattern is worse than no gate, because
 * the excuse looks like review. `poolDb` is the handle with no tenant binding;
 * `db` is the one that has it.
 *
 * What counts as tenant-scoped is read from `db/schema.ts` — the interface a
 * table maps to in `DbSchema`, and whether that interface declares `tenant_id`.
 * No database is consulted: a gate that needs one is a gate that skips when it
 * cannot have one.
 *
 * `zvd_*` is deliberately NOT treated as tenant-scoped by name. The prefix looks
 * like it should be — the dynamic collection tables carry it — but ten of the
 * `zvd_` tables in a live schema have no `tenant_id` at all (`zvd_relations`,
 * `zvd_collections`, `zvd_rls_policies` and friends are instance-level metadata).
 * A first version of this gate assumed the prefix and reported three findings,
 * every one of them wrong. Declared columns are the fact; the name is a guess.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './lib/strip-comments.js';

const ROOT = join(import.meta.dir, '..');
const SCHEMA = join(ROOT, 'packages/engine/src/db/schema.ts');
const ROUTES_DIR = join(ROOT, 'packages/engine/src/routes');

// ── which tables carry a tenant ───────────────────────────────────────────────
const schemaSrc = readFileSync(SCHEMA, 'utf8');

/** Interface body by name, so `tenant_id` can be looked up per table. */
const interfaceBodies = new Map<string, string>();
for (const m of schemaSrc.matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
  interfaceBodies.set(m[1]!, m[2]!);
}

const dbSchemaBlock = /export interface DbSchema\s*\{([\s\S]*?)\n\}/.exec(schemaSrc)?.[1] ?? '';
const tenantScoped = new Set<string>();
for (const m of dbSchemaBlock.matchAll(/^\s*'?([\w]+)'?\s*:\s*(\w+);/gm)) {
  const [, table, iface] = m;
  const body = interfaceBodies.get(iface!);
  if (body && /^\s*tenant_id\??\s*:/m.test(body)) tenantScoped.add(table!);
}

if (tenantScoped.size === 0) {
  console.error('[tenant-on-pool] FAIL — parsed no tenant-scoped tables out of schema.ts.');
  console.error('The gate cannot have checked anything; fix the parse rather than trusting it.');
  process.exit(1);
}

// ── scan the route handlers ──────────────────────────────────────────────────
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) out.push(p);
  }
  return out;
}

/**
 * `\s*` around the dot, not a same-line match.
 *
 * The scan used to run line by line, so it only ever saw `poolDb.selectFrom('t')`
 * written on ONE line — and a chain long enough to wrap is exactly what the
 * formatter turns into
 *
 *     const rows = await poolDb
 *       .selectFrom('zv_api_keys')
 *
 * which was invisible. Planted on 2026-09-04: the same violation the probe in
 * `audit-gates.ts` catches on one line stayed green when broken across two, and
 * every real call site in this codebase is long enough to wrap.
 */
// An alias (`'zv_api_keys as k'`) is the same table: it used to end the match
// at the space and leave the site uncounted.
const QUERY =
  /\bpoolDb\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom)\(\s*'([\w]+)(?:\s+as\s+\w+)?'/g;

/**
 * Sites read and understood, keyed `file:table`. Empty, and meant to stay that
 * way: an entry here is a promise that somebody checked the tenant binding by
 * hand, and an earlier version of this file shows how easily that becomes a
 * rubber stamp.
 */
const allowed = new Map<string, string>();

// `.setIsolationLevel(…)` / `.setAccessMode(…)` between the two still opens it on the pool.
const TXN =
  /\bpoolDb\s*\.\s*transaction\(\s*\)(?:\s*\.\s*set\w+\([^)]*\))*\s*\.\s*execute\(\s*async\s*\(\s*(\w+)/g;

/** Index of the `)` closing `execute(`, scanning from just after `async (trx` — two open. */
function callbackEnd(src: string, from: number): number {
  let depth = 2;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return src.length;
}

/** Index just past the backtick closing the template that opens at `open`. */
function templateEnd(src: string, open: number): number {
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '`') return i + 1;
    else if (src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      for (i += 2; i < src.length && depth > 0; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        else if (src[i] === '`') i = templateEnd(src, i) - 1;
      }
      i--;
    }
  }
  return src.length;
}

/**
 * The tables a raw `sql` template run on `handle` names — `sql\`…\`.execute(poolDb)`.
 * The Kysely-chain match above never sees a raw statement, and a raw SELECT on
 * the pool is exactly as unbound as `poolDb.selectFrom`.
 */
function rawSites(src: string, handle: string, from = 0, to = src.length) {
  const out: { at: number; text: string; table: string }[] = [];
  const run = new RegExp(`^\\s*\\.\\s*execute\\(\\s*${handle}\\s*\\)`);
  for (const m of src.slice(from, to).matchAll(/\bsql\s*(?:<[^`]*?>)?\s*`/g)) {
    const open = from + m.index! + m[0].length - 1;
    const end = templateEnd(src, open);
    if (!run.test(src.slice(end, end + 80))) continue;
    const body = src.slice(open, end);
    const named = new Set(
      [
        ...body.matchAll(
          /\b(?:FROM|JOIN|INTO|UPDATE|USING)\s+(?:ONLY\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi,
        ),
      ].map((t) => t[1]!),
    );
    // Any word naming a tenant table, wherever it stands: `public.zv_x`, the
    // second table of `FROM a, zv_x`, a subquery. Planted 2026-10-11, all green.
    for (const w of body.match(/\w+/g) ?? []) if (tenantScoped.has(w)) named.add(w);
    for (const table of named) {
      out.push({ at: open, text: `sql\`… ${table} …\`.execute(${handle})`, table });
    }
  }
  return out;
}

const findings: string[] = [];
/** Every `poolDb.<op>('t')` seen, matched or not — the gate's reach. */
let sitesSeen = 0;

for (const file of tsFiles(ROUTES_DIR)) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const rel = file.slice(ROOT.length + 1);

  const sites = [...src.matchAll(QUERY)].map((m) => ({ at: m.index!, text: m[0], table: m[2]! }));
  sites.push(...rawSites(src, 'poolDb'));

  // A transaction opened on the pool runs on the pool: `trx` inside
  // `poolDb.transaction().execute(async (trx) => …)` is as unbound as `poolDb`.
  // Planted on 2026-10-11 — `trx.selectFrom('zv_flows')` there stayed green.
  for (const t of src.matchAll(TXN)) {
    const start = t.index! + t[0].length;
    const op = new RegExp(`\\b${t[1]}${QUERY.source.slice('\\bpoolDb'.length)}`, 'g');
    for (const m of src.slice(start, callbackEnd(src, start)).matchAll(op)) {
      sites.push({ at: start + m.index!, text: m[0], table: m[2]! });
    }
    sites.push(...rawSites(src, t[1]!, start, callbackEnd(src, start)));
  }

  for (const { at, text, table } of sites) {
    sitesSeen++;
    const line = src.slice(0, at).split('\n').length;
    if (!tenantScoped.has(table)) continue;
    if (allowed.has(`${rel}:${table}`)) continue;
    findings.push(`${rel}:${line}  ${table}\n      ${text.replace(/\s+/g, ' ')}`);
  }
}

if (findings.length > 0) {
  console.error('[tenant-on-pool] FAIL — tenant-scoped table queried on `poolDb`:\n');
  for (const f of findings) console.error(`  ${f}\n`);
  console.error("Use the router's `db` — it is `createRequestScopedDb`, already bound to the");
  console.error('request transaction and therefore to the tenant policies. `poolDb` is the raw');
  console.error('pool and is for work that must not join the request transaction at all.');
  process.exit(1);
}

// The reach is printed, not implied.
//
// "none queried on `poolDb` from a route" reads as "I looked at the sites and
// they are fine". Measured on 2026-09-04 it meant something else: there are ZERO
// `poolDb.` query sites under `routes/`, because all four pool-backed routers
// receive the raw pool under the parameter name `db` — `insightsRoutes(poolDb,
// auth)` is `function insightsRoutes(db: Database)` inside, and its queries are
// spelled `db.selectFrom('zv_dashboards')`. So this gate has never judged a
// single one of the sites it exists for. See the note in the ledger for E01.
//
// Closed for `insights` (migration 026) and `flows` (migration 027): their
// parameter is spelled `poolDb` now, and their policed tables go through
// `withTenantIsolation`. `backup` and `sql-editor` still take the raw pool as
// `db` and stay unjudged here.
console.log(
  `[tenant-on-pool] OK — ${tenantScoped.size} tenant-scoped table(s) known; ` +
    `${sitesSeen} \`poolDb.\` query site(s) under routes/, none of them on a tenant table.` +
    (sitesSeen === 0
      ? '\n  NOTE: zero sites matched — `insights` and `flows` spell their pool `poolDb`; if they stopped,' +
        '\n  this gate is judging an empty set again.'
      : ''),
);
