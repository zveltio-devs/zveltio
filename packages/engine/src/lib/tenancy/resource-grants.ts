/**
 * Turning "everyone may read everything" into rows somebody decided on.
 *
 * The enforcer denies by default: a policy granting `*` on the object only
 * counts when the grant is total (see the matcher in `permissions.ts`). That
 * leaves a practical problem — the seeded `tenant_member` and `tenant_viewer`
 * roles were expressed entirely as partial wildcards, so without something to
 * replace them an upgrade would take every ordinary user's access away, and a
 * fresh install would start with nobody able to do anything.
 *
 * This module is that something. It writes, per resource, the rows the wildcard
 * used to stand in for. The access an operator sees after the change is the
 * access they had before it; the difference is that it is now enumerable. A row
 * can be read in the UI, revoked for one collection without touching the rest,
 * and shown to an auditor. `('tenant_member', '*', '*', 'read')` could do none
 * of those things.
 *
 * Resources come from two namespaces that do not overlap at all:
 *
 *   - collections, which the engine knows at runtime from `zvd_collections`
 *   - extension resources, the names passed to `permissionGate(ctx, '…')`,
 *     which exist only in extension source
 *
 * The second is why `KNOWN_EXTENSION_RESOURCES` exists rather than a query.
 * Going forward an extension declares its resources in its manifest and
 * `scripts/check-extension-resources.ts` fails the build if a `permissionGate`
 * call names something undeclared — the list below is the set that predates that
 * gate, kept so upgrading an existing install does not break the extensions
 * already on it.
 */
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { isSensitiveResource } from './permissions.js';

/**
 * What the seeded partial wildcards granted, written out.
 *
 * Deliberately identical to migration 009's intent — this is a change in how the
 * rule is expressed, not in who may do what. Owners and tenant admins are absent
 * because their grant is total (`'*', '*', '*'`) and still matches everything;
 * they are roles, not resource lists.
 */
export const DEFAULT_ROLE_GRANTS: ReadonlyArray<{ role: string; actions: readonly string[] }> = [
  { role: 'tenant_member', actions: ['read', 'create', 'update'] },
  { role: 'tenant_viewer', actions: ['read'] },
];

/**
 * Resource names owned by extensions rather than by `zvd_collections`.
 *
 * Harvested from every `permissionGate(ctx, '…')` call across the 57 extensions
 * at the time deny-by-default landed. Note that none of these is a collection
 * name: the two namespaces are disjoint, so a materialization that only walked
 * `zvd_collections` would silently close all 28 of them.
 */
export const KNOWN_EXTENSION_RESOURCES: readonly string[] = [
  'accounting',
  'api-connector',
  'assets',
  'banking',
  'checklists',
  'crm',
  'efactura',
  'employees',
  'etransport',
  'expenses',
  'export',
  'helpdesk',
  'import',
  'inventory',
  'invoices',
  'leave',
  'media',
  'payroll',
  'pos',
  'postgis',
  'procurement',
  'projects',
  'quotes',
  'ro-documents',
  'saft',
  'store',
  'subscriptions',
  'time-tracking',
];

/**
 * Give the standard roles their default access to `resources`.
 *
 * Skips anything `isSensitiveResource` withholds, and is idempotent: the unique
 * index on `zvd_permissions` makes a repeat call a no-op, so this is safe to run
 * on every boot and from every path that creates a resource.
 *
 * Returns the number of rows actually written, which is what the callers log —
 * a fresh install reports a few hundred, an upgraded one reports zero.
 */
export async function materializeDefaultGrants(
  db: Database,
  resources: readonly string[],
): Promise<number> {
  const targets = [...new Set(resources)].filter((r) => r && !isSensitiveResource(r));
  if (targets.length === 0) return 0;

  let written = 0;
  for (const resource of targets) {
    for (const { role, actions } of DEFAULT_ROLE_GRANTS) {
      for (const action of actions) {
        const result = await sql`
          INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
          VALUES ('p', ${role}, '*', ${resource}, ${action})
          ON CONFLICT DO NOTHING
        `.execute(db);
        written += Number(result.numAffectedRows ?? 0);
      }
    }
  }
  return written;
}

/**
 * Every resource name the engine can enumerate right now.
 *
 * Used by the boot reconcile. A collection created while the engine was on an
 * older version, or one belonging to an extension installed since, is picked up
 * here rather than needing its own migration.
 */
export async function listKnownResources(db: Database): Promise<string[]> {
  const collections = await sql<{ name: string }>`
    SELECT name FROM zvd_collections
  `.execute(db);
  return [...new Set([...collections.rows.map((r) => r.name), ...KNOWN_EXTENSION_RESOURCES])];
}
