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
 * Returns the number of rows actually written, which is what the boot reconcile
 * logs. Zero is the normal answer and not a sign that nothing happened: on a
 * fresh install migration 034 has already written every resource it could see,
 * and on a settled install there is nothing new. It goes above zero exactly
 * when something appeared that the migration could not have known about — a
 * collection created on an older engine, an extension installed since — which
 * is the only case worth putting on an operator's screen.
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
        // RETURNING, not `numAffectedRows`. This dialect reports 0n whether or
        // not a row was written, and omits the field entirely for raw `sql`
        // executes — so the obvious version counted every install as having
        // granted nothing. It did grant; only the number was a lie, which is
        // worse than no number, because the boot line an operator reads to
        // confirm the upgrade would have stayed silent on the one boot where it
        // mattered. The gate that caught it,
        // `scripts/check-affected-rows.ts`, has since been deleted: the dialect
        // reports affected rows now, so the ban it enforced would force RETURNING
        // forever for a problem that no longer exists. The RETURNING below stays —
        // it is what makes the count true, gate or no gate.
        const result = await sql<{ id: string }>`
          INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
          VALUES ('p', ${role}, '*', ${resource}, ${action})
          ON CONFLICT DO NOTHING
          RETURNING id
        `.execute(db);
        written += result.rows.length;
      }
    }
  }

  // A row in the table is not a grant until the enforcer has read it.
  //
  // Casbin keeps its policies in memory and `initPermissions` loads them once,
  // at boot. Both callers of this function run AFTER that: the reconcile a few
  // lines later in the boot sequence, and collection creation at any point
  // afterwards. So every row written here was invisible to `checkPermission`
  // until someone restarted the engine — which under deny-by-default means a
  // freshly created collection answered 403 to every ordinary user, with the
  // grant sitting in the database the whole time.
  //
  // In a Business OS, "create a collection" is the main activity, and an
  // administrator testing with their own account never sees it: their grant is
  // total and does not depend on any of this. That is the same blind spot that
  // hid the UUID column bug.
  //
  // The reload is worth noticing as an omission rather than an oversight: the
  // harness helper for these tests calls `loadPolicy()` after inserting rows,
  // with a comment explaining that a row written behind the enforcer is
  // invisible until reloaded. The production path was written without it.
  //
  // Only when something was actually written, so a settled install pays
  // nothing, and non-fatal: the rows are committed either way and the next boot
  // picks them up, which is the behaviour this replaces rather than one it
  // depends on.
  if (written > 0) {
    try {
      const { getEnforcer } = await import('./permissions.js');
      await (await getEnforcer()).loadPolicy();
    } catch (err) {
      console.warn(
        '[resource-grants] wrote grants but could not reload the enforcer; they take effect on restart:',
        (err as Error).message,
      );
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
