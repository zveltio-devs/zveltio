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
  'admin.ts:POST /migrate',
  'admin.ts:POST /sql',
  'admin.ts:POST /roles',
  'admin.ts:DELETE /roles/:id',
  'admin.ts:POST /permissions/bulk',
  'admin.ts:POST /roles/hierarchy',
  'admin.ts:DELETE /roles/hierarchy',
  'admin.ts:POST /column-permissions',
  'admin.ts:PUT /column-permissions/:id',
  'admin.ts:DELETE /column-permissions/:id',
  'admin.ts:PATCH /rate-limits/:keyPrefix',
  'admin.ts:POST /rate-limits/reset',
  'admin.ts:PATCH /api-keys/:id',
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
  'approvals.ts:POST /workflows',
  'approvals.ts:PUT /workflows/:id',
  'approvals.ts:DELETE /workflows/:id',
  'approvals.ts:POST /:id/decide',
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
