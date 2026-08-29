#!/usr/bin/env bun
/**
 * Every table declares which side of the tenancy boundary it is on.
 *
 * The prefix does not say. `zvd_collections`, `zvd_relations`, `zvd_rls_policies`
 * carry no `tenant_id` — they are instance-level, shared across tenants.
 * `zvd_webhooks` carries one. Same prefix, opposite sides, and the ambiguity has
 * already cost twice: a gate written on the belief that `zvd_` meant
 * tenant-scoped reported three pieces of correct code as violations, and the
 * premise of a whole branch (`perf/casbin-scaling`) was false for the same
 * reason — Casbin policies grow with tenants only if resources are per-tenant,
 * and collections are shared.
 *
 * The problem this gate solves is narrower and sharper than "classify things":
 * a table with no `tenant_id` looks IDENTICAL whether that was a decision or an
 * omission. So the classification is derived from the SQL — a table declares its
 * side by carrying `tenant_id` or not — and every instance-level table must
 * additionally appear in `quality-gates/tenant-boundary.json` with a reason. A
 * new table that carries no `tenant_id` and no entry is an omission until
 * somebody says otherwise.
 *
 * NINE of the instance-level tables reference a tenant-scoped parent:
 * `zv_flow_runs` → `zv_flows`, `zvd_dashboard_shares` → `zv_dashboards`, and so
 * on. Those are not leaks — the query sites checked join through the parent and
 * filter its `tenant_id` — but they are isolation with no second line: RLS has
 * no column to bind, so a forgotten join is a cross-tenant read with nothing
 * behind it. They are listed separately for that reason.
 *
 * Derived from SQL in BOTH repositories, with no database: a gate that needs one
 * is a gate that skips when it cannot have one, and Block C measured exactly
 * what that costs. Validated against ten tables whose side was already known
 * from `TENANCY-COVERAGE-CLASSIFICATION.md` before being trusted on the rest.
 *
 * Usage:
 *   bun run scripts/check-tenant-boundary.ts          # check
 *   bun run scripts/check-tenant-boundary.ts --list   # emit the derived split
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireSibling } from './lib/require-sibling.js';

const ROOT = join(import.meta.dir, '..');
const EXT_ROOT = join(ROOT, '..', 'zveltio-extensions');
const BASELINE = join(ROOT, 'quality-gates', 'tenant-boundary.json');
const LIST = process.argv.includes('--list');

requireSibling(EXT_ROOT, 'tenant-boundary');

/** Every `.sql` under a directory, recursively. */
function sqlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sqlUnder(p));
    else if (e.endsWith('.sql')) out.push(p);
  }
  return out;
}

const strip = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (t: string) => t.trim().replace(/"/g, '').split('.').pop()!.toLowerCase();

// The head only. The body is taken by counting parentheses, because a regex
// cannot balance them — and the first version, which demanded the closing paren
// on a line of its own, was blind to any `CREATE TABLE` written on ONE line.
// A planted single-line table left the gate green; reading the regex would never
// have shown that.
const CREATE_HEAD = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(["\w.]+)\s*\(/gi;

/** The parenthesised column list starting at `open`, or null if unbalanced. */
function bodyAt(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}
const ALTER_ADD =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?(["\w.]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(["\w]+)/gi;
const REFERENCES = /REFERENCES\s+(["\w.]+)/gi;
const HAS_TENANT_COL = /(^|,|\()\s*"?tenant_id"?\s/im;

const files = [
  ...sqlUnder(join(ROOT, 'packages/engine/src/db/migrations/sql')),
  ...sqlUnder(EXT_ROOT),
];
if (files.length === 0) {
  console.error('[tenant-boundary] FAIL — no SQL migrations found; the corpus is empty.');
  process.exit(1);
}

const created = new Set<string>();
const tenantScoped = new Set<string>();
const parents = new Map<string, Set<string>>();

for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(CREATE_HEAD)) {
    const body = bodyAt(src, m.index! + m[0]!.length - 1);
    if (body === null) continue;
    const t = norm(m[1]!);
    created.add(t);
    if (HAS_TENANT_COL.test(body)) tenantScoped.add(t);
    for (const r of body.matchAll(REFERENCES)) {
      if (!parents.has(t)) parents.set(t, new Set());
      parents.get(t)!.add(norm(r[1]!));
    }
  }
  // A later migration can add the column — 258 tables get it that way, so a
  // reader that only looks at CREATE gets the classification wrong for most of
  // the corpus.
  for (const m of src.matchAll(ALTER_ADD)) {
    if (norm(m[2]!) === 'tenant_id') tenantScoped.add(norm(m[1]!));
  }
}

const instance = [...created].filter((t) => !tenantScoped.has(t)).sort();
const childOfTenantTable = instance.filter((t) =>
  [...(parents.get(t) ?? [])].some((p) => tenantScoped.has(p)),
);

if (LIST) {
  console.log(
    JSON.stringify(
      {
        instance_level: Object.fromEntries(instance.map((t) => [t, 'REASON REQUIRED'])),
        child_of_tenant_table: Object.fromEntries(
          childOfTenantTable.map((t) => [
            t,
            [...(parents.get(t) ?? [])].filter((p) => tenantScoped.has(p)),
          ]),
        ),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`[tenant-boundary] FAIL — baseline missing: ${BASELINE}`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as {
  instance_level: Record<string, string>;
};
if (!baseline.instance_level) {
  console.error('[tenant-boundary] FAIL — baseline has no "instance_level" section.');
  process.exit(1);
}

const problems: string[] = [];

for (const t of instance) {
  if (t in baseline.instance_level) continue;
  const ps = [...(parents.get(t) ?? [])].filter((p) => tenantScoped.has(p));
  problems.push(
    `  ${t}\n` +
      '      carries no `tenant_id` and is not declared instance-level.\n' +
      (ps.length
        ? `      It references ${ps.join(', ')}, which IS tenant-scoped — so isolation here\n` +
          '      rests entirely on every query joining through the parent, with no RLS behind it.\n'
        : '') +
      '      Add `tenant_id`, or record it in quality-gates/tenant-boundary.json with the reason.',
  );
}

// The other direction: an entry that no longer describes anything. Left alone it
// is a permanent excuse for nothing, and it hides the row that replaced it.
for (const t of Object.keys(baseline.instance_level).sort()) {
  if (t.startsWith('_')) continue;
  if (!created.has(t)) {
    problems.push(
      `  ${t}\n      declared instance-level but no migration creates it — remove the entry.`,
    );
  } else if (tenantScoped.has(t)) {
    problems.push(`  ${t}\n      now carries \`tenant_id\` — remove it from "instance_level".`);
  }
}

if (problems.length > 0) {
  console.error('[tenant-boundary] FAIL —');
  for (const p of problems) console.error(p);
  process.exit(1);
}

console.log(
  `[tenant-boundary] OK — ${created.size} tables: ${created.size - instance.length} tenant-scoped, ` +
    `${instance.length} declared instance-level (${childOfTenantTable.length} of them children of a ` +
    'tenant-scoped table, isolated by join alone).',
);
