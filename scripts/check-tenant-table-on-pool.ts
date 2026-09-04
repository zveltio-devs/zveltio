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
 * design, which is why the engine's own role is not restricted — see the note in
 * `docs/private/CASBIN-SCALING-STATE.md`.
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
const QUERY = /\bpoolDb\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom)\(\s*'([\w]+)'/g;

/**
 * Sites read and understood, keyed `file:table`. Empty, and meant to stay that
 * way: an entry here is a promise that somebody checked the tenant binding by
 * hand, and the previous version of this file shows how easily that becomes a
 * rubber stamp.
 */
/**
 * Sites read and understood, keyed `file:table`. Empty, and meant to stay that
 * way: an entry here is a promise that somebody checked the tenant binding by
 * hand, and an earlier version of this file shows how easily that becomes a
 * rubber stamp.
 */
const allowed = new Map<string, string>();

const findings: string[] = [];
/** Every `poolDb.<op>('t')` seen, matched or not — the gate's reach. */
let sitesSeen = 0;

/** Line and block comments blanked, newlines kept so line numbers survive. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

for (const file of tsFiles(ROUTES_DIR)) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const rel = file.slice(ROOT.length + 1);

  QUERY.lastIndex = 0;
  for (const m of src.matchAll(QUERY)) {
    sitesSeen++;
    const table = m[2]!;
    const line = src.slice(0, m.index!).split('\n').length;
    if (!tenantScoped.has(table)) continue;
    if (allowed.has(`${rel}:${table}`)) continue;
    findings.push(`${rel}:${line}  ${table}\n      ${m[0].replace(/\s+/g, ' ')}`);
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
// single one of the sites it exists for. Saying so out loud is the smallest
// honest change; teaching it to resolve the alias would make it start failing on
// production code and is a decision for the owner, not a repair. See the note in
// the ledger for E01.
console.log(
  `[tenant-on-pool] OK — ${tenantScoped.size} tenant-scoped table(s) known; ` +
    `${sitesSeen} \`poolDb.\` query site(s) under routes/, none of them on a tenant table.` +
    (sitesSeen === 0
      ? '\n  NOTE: zero sites matched. The four pool-backed routers take the raw pool as `db`,' +
        '\n  so nothing under routes/ spells `poolDb.` and this gate is judging an empty set.'
      : ''),
);
