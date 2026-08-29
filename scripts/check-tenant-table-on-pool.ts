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

const QUERY = /\bpoolDb\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom)\(\s*'([\w]+)'/g;

/**
 * Sites read and understood, keyed `file:table`. Empty, and meant to stay that
 * way: an entry here is a promise that somebody checked the tenant binding by
 * hand, and the previous version of this file shows how easily that becomes a
 * rubber stamp.
 */
const allowed = new Map<string, string>();

const findings: string[] = [];

for (const file of tsFiles(ROUTES_DIR)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = file.slice(ROOT.length + 1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
    QUERY.lastIndex = 0;
    for (const m of line.matchAll(QUERY)) {
      const table = m[2]!;
      if (!tenantScoped.has(table)) continue;
      if (allowed.has(`${rel}:${table}`)) continue;
      findings.push(`${rel}:${i + 1}  ${table}\n      ${line.trim().slice(0, 100)}`);
    }
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

console.log(
  `[tenant-on-pool] OK — ${tenantScoped.size} tenant-scoped table(s) known, none queried on \`poolDb\` from a route.`,
);
