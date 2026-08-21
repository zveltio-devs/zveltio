#!/usr/bin/env bun
/**
 * Audit regression check — fail CI if a handler that *should* call auditLog
 * has lost its call between commits. Run after `audit-inventory.ts`.
 *
 * The list of mandatory-audit handlers is encoded explicitly below, not
 * inferred. Inference (e.g. "every route starting with /admin must audit")
 * would either be too lax (DDoSes the audit log with reads) or too strict
 * (forces audit calls on innocuous metadata reads). Maintainers add to this
 * list when they introduce new privileged paths.
 */

import { readFile } from 'node:fs/promises';

interface InventoryEntry {
  file: string;
  method: string;
  path: string;
  lineStart: number;
  audited: boolean;
}

interface Inventory {
  covered: InventoryEntry[];
  gaps: InventoryEntry[];
}

/**
 * Handlers that MUST have an auditLog() call. Key = "<basename>:<METHOD> <path>".
 * The check is exact-match. When you rename a route, update this list.
 */
const MANDATORY: ReadonlySet<string> = new Set([
  // Privileged admin routes — moved out of admin.ts into routes/admin/* by the
  // H-07 split (register-fn pattern; auditLog() calls preserved). Keys track the
  // new owning file. audit-inventory.ts now recurses into routes/admin/.
  'system-routes.ts:POST /migrate',
  // The SQL editor. It lived in config-routes.ts as a second implementation
  // that shadowed the dedicated one — mounted at /api/admin, it matched
  // POST /api/admin/sql before routes/index.ts:447 ever saw the request, so the
  // version with the stronger gate was unreachable. The duplicate is gone and
  // the key follows the surviving route.
  //
  // Worth noting what this list did here: it is the only thing that objected to
  // the removal. Deleting the entry would have been the quick way past it, and
  // would have quietly dropped the requirement that ad-hoc SQL be audited at
  // all.
  'sql-editor.ts:POST /',
  'permission-routes.ts:POST /roles',
  'permission-routes.ts:DELETE /roles/:id',
  'permission-routes.ts:POST /permissions/bulk',
  'permission-routes.ts:POST /roles/hierarchy',
  'permission-routes.ts:DELETE /roles/hierarchy',
  'config-routes.ts:POST /column-permissions',
  'config-routes.ts:PUT /column-permissions/:id',
  'config-routes.ts:DELETE /column-permissions/:id',
  'config-routes.ts:PATCH /rate-limits/:keyPrefix',
  'config-routes.ts:POST /rate-limits/reset',
  'system-routes.ts:PATCH /api-keys/:id',
  'backup.ts:POST /',
  'backup.ts:DELETE /:id',
  'backup.ts:PATCH /pitr/config',
  'backup.ts:POST /pitr/restore',
  'backup.ts:POST /schedules',
  'backup.ts:PATCH /schedules/:id',
  'backup.ts:DELETE /schedules/:id',
  'collections.ts:PATCH /:name',
  'collections.ts:POST /:name/fields',
  'collections.ts:PATCH /:name/fields/:field',
  'collections.ts:DELETE /:name/fields/:field',
  // approvals.ts removed from core — owned by extensions/workflow/approvals
  // (/ext/workflow/approvals). Do not re-add /api/approvals twin handlers.
]);

function keyFor(e: InventoryEntry): string {
  const fname = e.file.split(/[\\/]/).pop()!;
  return `${fname}:${e.method} ${e.path}`;
}

async function main(): Promise<void> {
  const inv = JSON.parse(await readFile('audit-inventory.json', 'utf8')) as Inventory;
  const auditedKeys = new Set(inv.covered.map(keyFor));

  const missing = [...MANDATORY].filter((k) => !auditedKeys.has(k));
  const extras: string[] = [];
  // Sanity: every mandatory entry should at least exist in the codebase as a
  // route (either covered or gap). If not, the route was renamed/removed and
  // this list is stale.
  const allKeys = new Set([...inv.covered.map(keyFor), ...inv.gaps.map(keyFor)]);
  for (const k of MANDATORY) {
    if (!allKeys.has(k)) extras.push(k);
  }

  if (missing.length === 0 && extras.length === 0) {
    console.log(`✓ Audit regression check passed — ${MANDATORY.size} mandatory handlers audited.`);
    return;
  }

  if (missing.length > 0) {
    console.error('\n✗ The following privileged handlers have no auditLog() call:');
    for (const k of missing) console.error(`  - ${k}`);
    console.error(
      '\n  Add auditLog(...) to the handler, or remove from MANDATORY in scripts/audit-regression-check.ts if intentional.',
    );
  }
  if (extras.length > 0) {
    console.error('\n✗ The following entries in MANDATORY refer to routes that no longer exist:');
    for (const k of extras) console.error(`  - ${k}`);
    console.error('\n  Update scripts/audit-regression-check.ts after refactoring.');
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('✗ audit-regression-check failed:', err?.message ?? err);
  process.exit(2);
});
