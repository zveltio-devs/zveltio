#!/usr/bin/env bun
/**
 * A route handler must not query a tenant-scoped table on the raw pool.
 *
 * `tenantMiddleware` opens the request transaction and hands it over as
 * `c.get('tenantTrx')`; `reqDb(c, db)` is how a handler picks it up. The
 * transaction is where `SET LOCAL` lives, so it is the only place a query is
 * bound by the tenant policies. The same query on the route's raw `db` runs on
 * the pool as the engine's own role and sees every tenant's rows.
 *
 * The idiom that makes this easy to get wrong is `reqDb`'s own fallback:
 *
 *     const trx = c.get('tenantTrx');
 *     return trx ?? fallback;          // ← no transaction? use the pool
 *
 * That fallback is right for single-tenant installs, where no transaction is
 * opened at all. It is also exactly what would turn a missing transaction into
 * a silent cross-tenant read — which is why this gate exists BEFORE anyone makes
 * the transaction lazy. Forty-five call sites reach for that fallback today; a
 * lazy transaction that fails to open would convert all of them at once, and
 * nothing else in the build would notice.
 *
 * The repository has been here: a synchronous `finally` once cleared the
 * transaction early and left 302 policies inert, and the tests stayed green.
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

const QUERY = /\bdb\s*\.\s*(selectFrom|insertInto|updateTable|deleteFrom)\(\s*'([\w]+)'/g;

/**
 * Sites read and understood, keyed `file:table`.
 *
 * The gate sees one statement at a time and cannot see a guard three lines
 * above it. Each entry here is a case where the tenant check is real but lives
 * in a different statement, and the reason is written out so the next reader
 * does not have to re-derive it.
 */
const allowed = new Map<string, string>([
  [
    'packages/engine/src/routes/insights.ts:zv_dashboards',
    'The DELETE is preceded by a SELECT of the same id with `.where(tenant_id, =, tenantOf(c))` ' +
      'that answers 404 when it misses, so the id is already proven to belong to the caller.',
  ],
]);

const findings: string[] = [];

for (const file of tsFiles(ROUTES_DIR)) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = file.slice(ROOT.length + 1);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
    // `reqDb(c, db).selectFrom(...)` is the correct form and ends in `db)` — the
    // pattern below would otherwise read its argument as the raw pool.
    if (/reqDb\s*\(/.test(line)) continue;

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
  console.error('[tenant-on-pool] FAIL — tenant-scoped table queried on the raw pool:\n');
  for (const f of findings) console.error(`  ${f}\n`);
  console.error('Use `reqDb(c, db)` so the query runs inside the request transaction.');
  console.error('If the router genuinely belongs on the pool, it belongs in TXN_SKIP_PREFIXES,');
  console.error('and the reason belongs next to the entry there.');
  process.exit(1);
}

console.log(
  `[tenant-on-pool] OK — ${tenantScoped.size} tenant-scoped table(s) known, none queried on the pool from a route.`,
);
