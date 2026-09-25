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
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  getEnforcer,
  invalidateAllPermissionCaches,
  isSensitiveResource,
  publishPolicyChange,
  trackPolicyWrite,
} from './permissions.js';

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
 *
 * The declarations are on disk and authoritative: an extension names its
 * resources in `manifest.resources`, `register.ts` materializes them as it
 * loads, and `listKnownResources` below reads the same field for everything
 * installed.
 *
 * There used to be a frozen array here as well, holding the 28 names that
 * predate that wiring. It was removed on 2026-08-30 as an owner decision, with
 * a minimum stated: **an extension must declare `manifest.resources`**, which
 * has been the contract since 3.0.0-beta.63 (2026-08-28) and is enforced for new
 * code by `scripts/check-extension-resources.ts`. An install carrying older
 * bundles no longer gets those names for free.
 *
 * Deleting a safety net silently would have been the wrong half of that
 * decision: a missing name means `materializeDefaultGrants` never opens the
 * resource, and deny-by-default then refuses access with nothing to point at.
 * So an installed extension that declares nothing is now NAMED at boot.
 */

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
  // Its rows would be announced to every instance and put into this one's
  // model before they commit — and kept there if the caller rolled back.
  if ((db as unknown as { isTransaction?: boolean }).isTransaction) {
    throw new Error(
      'materializeDefaultGrants must run on the pool, not inside a transaction: ' +
        'it publishes the grants to the other instances as soon as it writes them.',
    );
  }
  const targets = [...new Set(resources)].filter((r) => r && !isSensitiveResource(r));
  if (targets.length === 0) return 0;
  return trackPolicyWrite(() => writeDefaultGrants(db, targets));
}

async function writeDefaultGrants(db: Database, targets: string[]): Promise<number> {
  let written = 0;
  const rules: string[][] = [];
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
        rules.push([role, '*', resource, action]);
      }
    }
  }

  // A row in the table is not a grant until the enforcer has read it.
  //
  // Casbin keeps its policies in memory and `initPermissions` loads them once,
  // at boot. Both callers of this function run AFTER that: the reconcile a few
  // lines later in the boot sequence, and collection creation at any point
  // afterwards. Without this a freshly created collection answered 403 to every
  // ordinary user until a restart, with the grant sitting in the database.
  //
  // The rules go straight into the live model — never `enforcer.loadPolicy()`.
  // That one is `model.clearPolicy()`, then a SELECT, then a role-link rebuild
  // that clears the role manager and re-adds each link across awaits, and every
  // request in flight reads the same enforcer meanwhile. Measured
  // (`casbin-reload-window.test.ts`): a check during the SELECT saw no policies
  // and cached an empty policy-object index, after which every resource shared
  // one cache key — a member allowed `contacts` was then allowed `payroll`; a
  // row-rule lookup during the rebuild saw no roles and skipped the member's rule.
  // `Model.addPolicy` is synchronous and skips a rule already held, so this
  // adds exactly what the table now holds for these resources and clears nothing.
  //
  // Then the other instances, which would otherwise keep answering 403 until
  // they restart, and every cached answer: a `0` filed for one of these
  // resources a moment ago lives out its TTL in the SHARED cache otherwise.
  //
  // Non-fatal: the rows are committed either way and the next boot loads them.
  try {
    const model = (await getEnforcer()).getModel();
    const added = rules.filter((rule) => model.addPolicy('p', 'p', rule));
    if (added.length > 0) {
      publishPolicyChange({ sec: 'p', ptype: 'p', rules: added });
      await invalidateAllPermissionCaches();
    }
  } catch (err) {
    console.warn(
      '[resource-grants] wrote grants but could not add them to the enforcer; they take effect on restart:',
      (err as Error).message,
    );
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
export async function listKnownResources(db: Database, extensionsBase?: string): Promise<string[]> {
  const collections = await sql<{ name: string }>`
    SELECT name FROM zvd_collections
  `.execute(db);
  const declared = extensionsBase ? await resourcesDeclaredOnDisk(db, extensionsBase) : [];
  return [...new Set([...collections.rows.map((r) => r.name), ...declared])];
}

/**
 * `manifest.resources` for everything installed, read from disk.
 *
 * The frozen array above was the only extension-side input this reconcile had,
 * which made it go stale by construction: an extension installed but not loaded
 * on this boot contributed nothing, and the fix was to edit engine source. The
 * declarations are already on disk and already authoritative — `register.ts`
 * materializes from the same field — so read them instead of remembering them.
 */
async function resourcesDeclaredOnDisk(db: Database, base: string): Promise<string[]> {
  // Bun.file(path).exists() returns false for directories, so stat + isDirectory
  // is the correct existence check for the extensions base path.
  try {
    const st = await Bun.file(base).stat();
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  let installed: string[];
  try {
    const rows = await sql<{ name: string }>`
      SELECT name FROM zv_extension_registry WHERE is_installed = true
    `.execute(db);
    installed = rows.rows.map((r) => r.name);
  } catch (err) {
    // Before the registry table exists there is nothing to read. There is no
    // longer a frozen list behind this, so the reconcile simply covers fewer
    // resources on this boot — which is worth saying out loud rather than
    // swallowing.
    console.warn(
      '[resource-grants] could not read the extension registry; extension resources ' +
        'are not in this reconcile:',
      (err as Error).message,
    );
    return [];
  }

  const out: string[] = [];
  const silent: string[] = [];
  for (const name of installed) {
    const manifestPath = join(base, name, 'manifest.json');
    if (!(await Bun.file(manifestPath).exists())) {
      silent.push(name);
      continue;
    }
    try {
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { resources?: unknown };
      const declared = Array.isArray(manifest.resources)
        ? manifest.resources.filter((r): r is string => typeof r === 'string' && r !== '')
        : [];
      if (declared.length === 0) silent.push(name);
      out.push(...declared);
    } catch (err) {
      silent.push(name);
      console.warn(
        `[resource-grants] ${name}: manifest.json could not be read; its resources are ` +
          'not in this reconcile:',
        (err as Error).message,
      );
    }
  }

  // Named, not counted. Deny-by-default refuses access to a resource nobody
  // granted, and the refusal carries no hint about why — so an operator whose
  // extension stopped working after an upgrade needs to read the name here.
  if (silent.length > 0) {
    console.warn(
      `[resource-grants] ${silent.length} installed extension(s) declare no ` +
        `manifest.resources, so nothing was granted on them: ${silent.sort().join(', ')}. ` +
        'Update them to a build that declares resources (required since 3.0.0-beta.63).',
    );
  }
  return out;
}
