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
 * omission.
 *
 * The SAME sentence is true on the other side of the boundary, and used not to
 * be checked at all. A table that carries `tenant_id` and has no policy also
 * looks identical whether that was a decision (`zv_api_keys` is looked up by
 * hash, before any tenant is known — a policy there breaks API-key auth
 * outright) or an omission. This gate counted 333 tables as "tenant-scoped" and
 * never asked whether any of them was actually policed. Three of them were not,
 * and firm B could read AND overwrite firm A's rows through five routes for
 * months while this printed OK. It did not stay silent — it confirmed.
 *
 * So the second half: every tenant-scoped table must either enable row level
 * security somewhere in the SQL, or be declared in `unpoliced` with the reason. So the classification is derived from the SQL — a table declares its
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

// Two shapes, because both are used and only one is literal.
const ENABLE_RLS = /ALTER\s+TABLE\s+(?:ONLY\s+)?(["\w.]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
// The other shape is a `DO $$ FOREACH t IN ARRAY ARRAY['a','b'] ... EXECUTE
// format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t)` loop, where the table
// names are string literals in the array and never appear next to the statement.
// Reading only the literal form would report every table protected that way as
// unpoliced — five of this repo's own tables, and the whole checklists
// extension. The array is only trusted inside a file that creates a
// `tenant_isolation` policy, so an unrelated ARRAY of strings cannot grant
// protection it did not write.
const ARRAY_LITERALS = /ARRAY\s*\[([^\]]+)\]/gi;
const QUOTED = /'([\w.]+)'/g;

const files = [
  ...sqlUnder(join(ROOT, 'packages/engine/src/db/migrations/sql')),
  ...sqlUnder(EXT_ROOT),
];
if (files.length === 0) {
  console.error('[tenant-boundary] FAIL — no SQL migrations found; the corpus is empty.');
  process.exit(1);
}

/**
 * Who owns a file: the engine, or one extension directory. Migrations are
 * ordered within an owner and NOT across owners — the engine's run first, then
 * each extension's — so a conditional loop can only be trusted inside one.
 */
function ownerFor(file: string): string {
  if (!file.startsWith(EXT_ROOT)) return 'engine';
  const rel = file.slice(EXT_ROOT.length).replace(/^\/+/, '');
  const parts = rel.split('/');
  const i = parts.indexOf('engine');
  return i > 0 ? parts.slice(0, i).join('/') : parts[0]!;
}

const created = new Set<string>();
/** Which owner's migrations create each table. */
const ownerOf = new Map<string, string>();
const tenantScoped = new Set<string>();
/** Tables the SQL puts row level security on, in either shape. */
const policed = new Set<string>();
const parents = new Map<string, Set<string>>();

// Two passes: ownership must be known for every table before any file is
// judged, because an extension's tables are created in files read after the
// engine's.
for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const own = ownerFor(f);
  for (const m of src.matchAll(CREATE_HEAD)) {
    const t = norm(m[1]!);
    if (!ownerOf.has(t)) ownerOf.set(t, own);
  }
}

for (const f of files) {
  const src = strip(readFileSync(f, 'utf8'));
  const owner = ownerFor(f);
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
  for (const m of src.matchAll(ENABLE_RLS)) policed.add(norm(m[1]!));
  //
  // ...but such a loop almost always guards itself with
  // `IF to_regclass(...) IS NULL THEN CONTINUE`, which reads as "protect it if
  // it is here" — and whether it is here depends on load order.
  //
  // Within one owner that is safe: `content/pages/001` creates its nine tables
  // at the top of the file and protects them at the bottom; engine
  // `004_tenancy_hierarchy` protects engine tables created in engine `001`.
  //
  // ACROSS owners it is not, and that is not hypothetical. That same engine
  // migration also names `zv_checklist_scoring_schemes` and its two siblings —
  // tables belonging to an extension, whose migrations run AFTER the engine's.
  // They were never present when the loop ran, so all three went unprotected in
  // every install ever made, while two engine tables in the SAME array were
  // fine. Same code, opposite outcome, decided by load order.
  //
  // The first version of this parser credited the array outright and reported
  // the corpus clean with that leak in it — a gate that confirms rather than
  // checks, which is the thing this file exists to stop. Found by planting:
  // the fix was removed and the gate stayed green.
  const conditional = /to_regclass/i.test(src);
  if (/CREATE\s+POLICY\s+(?:%I|["\w]*tenant_isolation)/i.test(src)) {
    for (const a of src.matchAll(ARRAY_LITERALS)) {
      for (const q of a[1]!.matchAll(QUOTED)) {
        const t = norm(q[1]!);
        if (!conditional || ownerOf.get(t) === owner) policed.add(t);
      }
    }
  }
}

const instance = [...created].filter((t) => !tenantScoped.has(t)).sort();
const unpoliced = [...tenantScoped].filter((t) => !policed.has(t)).sort();
const childOfTenantTable = instance.filter((t) =>
  [...(parents.get(t) ?? [])].some((p) => tenantScoped.has(p)),
);

if (LIST) {
  console.log(
    JSON.stringify(
      {
        instance_level: Object.fromEntries(instance.map((t) => [t, 'REASON REQUIRED'])),
        unpoliced: Object.fromEntries(unpoliced.map((t) => [t, 'REASON REQUIRED'])),
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
  unpoliced: Record<string, string>;
};
if (!baseline.instance_level) {
  console.error('[tenant-boundary] FAIL — baseline has no "instance_level" section.');
  process.exit(1);
}
if (!baseline.unpoliced) {
  console.error('[tenant-boundary] FAIL — baseline has no "unpoliced" section.');
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

for (const t of unpoliced) {
  if (t in baseline.unpoliced) continue;
  problems.push(
    `  ${t}\n` +
      '      carries `tenant_id` but no migration enables row level security on it.\n' +
      '      The column marks the row; only a policy enforces it. Without one, any\n' +
      '      route that looks the row up by an id from the request reaches every\n' +
      "      tenant's — reads AND writes.\n" +
      '      Add ENABLE/FORCE ROW LEVEL SECURITY and a `tenant_isolation_*` policy,\n' +
      '      or record it in quality-gates/tenant-boundary.json under "unpoliced"\n' +
      '      with the reason it must stay reachable across tenants.',
  );
}

// The other direction, for both sections: an entry that no longer describes
// anything.
for (const t of Object.keys(baseline.unpoliced).sort()) {
  if (t.startsWith('_')) continue;
  if (!created.has(t)) {
    problems.push(
      `  ${t}\n      declared unpoliced but no migration creates it — remove the entry.`,
    );
  } else if (policed.has(t)) {
    problems.push(
      `  ${t}\n      now has row level security — remove it from "unpoliced".\n` +
        '      Leaving it is a standing excuse for a hole that is already closed.',
    );
  } else if (!tenantScoped.has(t)) {
    problems.push(`  ${t}\n      no longer carries \`tenant_id\` — remove it from "unpoliced".`);
  }
}

// An entry that no longer describes anything. Left alone it
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
  `[tenant-boundary] OK — ${created.size} tables: ${created.size - instance.length} tenant-scoped ` +
    `(${tenantScoped.size - unpoliced.length} policed, ${unpoliced.length} declared reachable across ` +
    `tenants), ${instance.length} declared instance-level (${childOfTenantTable.length} of them ` +
    'children of a tenant-scoped table, isolated by join alone).',
);
