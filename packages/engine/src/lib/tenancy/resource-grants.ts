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
 * `scripts/check-extension-authorization.ts` in the extensions repo fails its
 * build if a `permissionGate`
 * call names something undeclared — the list below is the set that predates that
 * gate, kept so upgrading an existing install does not break the extensions
 * already on it.
 */
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  DEFAULT_ROLE_GRANTS,
  ENGINE_CASBIN_OBJECTS,
  EXTENSION_RESOURCE_GRANTS,
  forgetDeletedPolicies,
  getEnforcer,
  invalidateAllPermissionCaches,
  isSensitiveResource,
  listSensitiveResources,
  publishPolicyChange,
  registerSensitiveResources,
  trackPolicyWrite,
} from './permissions.js';

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
 * code by `scripts/check-extension-authorization.ts` in the extensions repo. An
 * install carrying older
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
 * Skips anything `isSensitiveResource` withholds and any grant an operator
 * revoked (`zv_default_grant_revocations`), and is idempotent: the unique
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
  /** `resources` are an extension's `manifest.resources`, not collections. */
  opts: { extension?: boolean } = {},
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
  const grants = opts.extension
    ? [...DEFAULT_ROLE_GRANTS, ...EXTENSION_RESOURCE_GRANTS]
    : DEFAULT_ROLE_GRANTS;
  return trackPolicyWrite(() => writeDefaultGrants(db, targets, grants));
}

async function writeDefaultGrants(
  db: Database,
  targets: string[],
  grants: typeof DEFAULT_ROLE_GRANTS,
): Promise<number> {
  let written = 0;
  const rules: string[][] = [];
  for (const resource of targets) {
    for (const { role, actions } of grants) {
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
        //
        // A triple an operator revoked stays revoked (migration 086). Checked in
        // the INSERT's own statement, not read once ahead of the loop, so a revoke
        // racing this call can only slip past within that one statement.
        const result = await sql<{ revoked: boolean; written: number }>`
          WITH r AS (
            SELECT EXISTS (SELECT 1 FROM zv_default_grant_revocations
                            WHERE role = ${role} AND resource = ${resource}
                              AND action = ${action}) AS revoked
          ), ins AS (
            INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
            SELECT 'p', ${role}, '*', ${resource}, ${action} FROM r WHERE NOT r.revoked
            ON CONFLICT DO NOTHING
            RETURNING id
          )
          SELECT (SELECT revoked FROM r) AS revoked, (SELECT count(*) FROM ins)::int AS written
        `.execute(db);
        const row = result.rows[0];
        if (row?.revoked) continue;
        written += row?.written ?? 0;
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
 * Register the `sensitiveResources` of every extension the registry still has a
 * row for, read from disk: installed, or soft uninstalled — whose tables, data
 * and files stay, so what it asked to keep closed stays closed. `declaredBy`
 * reads only installed ones, and a restart forgets everything else. Only a
 * purge, which deletes the row with the data, takes them away
 * (`forgetSensitiveResources`). Resolves the ones whose manifest could not be
 * read: what they keep closed is unknown.
 */
export async function registerRegisteredSensitiveResources(
  db: Database,
  extensionsBase: string,
): Promise<string[]> {
  const { unreadable } = await declaredBy(extensionsBase, await registeredExtensions(db));
  return unreadable;
}

/**
 * Names of the extensions whose data is still there: every one with a registry
 * row, installed or soft uninstalled. A purge deletes the row with the data.
 */
async function registeredExtensions(db: Database): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    SELECT DISTINCT name FROM zv_extension_registry`.execute(db);
  return rows.map((r) => r.name);
}

/** `zv_settings` key: `repairSensitiveDefaultGrants` has run on this database. */
export const SENSITIVE_DEFAULTS_REPAIRED = 'repair:sensitive_default_grants';

/**
 * Once per database: delete the default-shaped rules on every sensitive name —
 * a `DEFAULT_ROLE_GRANTS` or `EXTENSION_RESOURCE_GRANTS` (role, action) in
 * domain `*`. Until an installed but disabled extension's `sensitiveResources`
 * were registered before granting, the boot reconcile and createCollection
 * wrote its defaults on them, and every boot kept them.
 *
 * Such a row is the same triple as an operator's grant, so an identical
 * operator grant goes too (owner decision, 2026-10-25): each removed row is
 * logged, and the operator re-grants it by name. Once only, so a grant made
 * after the repair stays. No revocation is recorded: a sensitive name gets no
 * default anyway (`deleteRecordingRevokes` records none on one), and a name
 * that stops being sensitive then starts as it would on a fresh install.
 *
 * Waits, and says so, while an extension with a registry row has no readable
 * manifest (`unreadable`): the names it keeps closed are unknown, and the run
 * is not repeated. The marker is claimed in the delete's transaction: another
 * replica's claim waits on the key, then finds it taken.
 */
export async function repairSensitiveDefaultGrants(
  db: Database,
  unreadable: readonly string[],
): Promise<string[][]> {
  if (unreadable.length > 0) {
    console.warn(
      `[resource-grants] default grants on sensitive names not repaired yet: ${unreadable.join('; ')}. ` +
        'Retried on the next boot.',
    );
    return [];
  }
  const defaults = [...DEFAULT_ROLE_GRANTS, ...EXTENSION_RESOURCE_GRANTS].flatMap(
    ({ role, actions }) => actions.map((action) => sql`(${role}, ${action})`),
  );
  const rules = await trackPolicyWrite(() =>
    db.transaction().execute(async (trx) => {
      const claimed = await sql`
        INSERT INTO zv_settings (key, value, description)
        VALUES (${SENSITIVE_DEFAULTS_REPAIRED}, 'true'::jsonb,
                'Default grants on sensitive names removed once; see resource-grants.ts.')
        ON CONFLICT (key) DO NOTHING RETURNING key`.execute(trx);
      if (claimed.rows.length === 0) return [];
      const { rows } = await sql<{ v0: string; v2: string; v3: string }>`
        DELETE FROM zvd_permissions
         WHERE ptype = 'p' AND v1 = '*'
           AND v2 IN (${sql.join(listSensitiveResources())})
           AND (v0, v3) IN (${sql.join(defaults)})
           AND COALESCE(v4, '') = '' AND COALESCE(v5, '') = ''
        RETURNING v0, v2, v3`.execute(trx);
      return rows.map((r) => [r.v0, '*', r.v2, r.v3]);
    }),
  );
  for (const r of rules) {
    console.warn(
      `[resource-grants] removed default-shaped grant on sensitive name: ${r.join(', ')} ` +
        '(re-grant it by name if it was intended)',
    );
  }
  if (rules.length > 0) {
    await forgetDeletedPolicies(rules);
    await invalidateAllPermissionCaches({ shared: true });
  }
  return rules;
}

/** Names of the extensions the registry marks installed, in any tenant. */
async function installedExtensions(db: Database): Promise<string[]> {
  const rows = await sql<{ name: string }>`
    SELECT name FROM zv_extension_registry WHERE is_installed = true
  `.execute(db);
  return rows.rows.map((r) => r.name);
}

/**
 * The collections `manifest`'s actions are gated on outside its `resources`
 * (extension model v3): the manifest schema admits those only when its actions or jobs
 * read or write them. Untyped, for a manifest read from disk.
 */
export function actionCollections(manifest: { resources?: unknown; actions?: unknown }): string[] {
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  return actions
    .map((a) => (a as { permission?: { resource?: unknown } } | null)?.permission?.resource)
    .filter((r): r is string => typeof r === 'string' && r !== '' && !resources.includes(r));
}

/**
 * Which of `names` are collections now. A rule is written on a collection only
 * once it exists (extension model v3), so it is younger than the collection and
 * the drop takes it (rule 2).
 */
export async function existingCollections(
  db: Database,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM zvd_collections WHERE name IN (${sql.join([...new Set(names)])})
  `.execute(db);
  return rows.map((r) => r.name);
}

/**
 * The existing collections an installed extension's action is gated on: they
 * get `execute` like a declared resource, but stay collections — never in
 * `nonCollectionObjects`, so their rules live and die with them.
 */
export async function listActionCollections(db: Database, base: string): Promise<string[]> {
  const { gated } = await declaredBy(base, await installedExtensions(db));
  return existingCollections(db, gated);
}

/**
 * `manifest.resources` of `installed`, the collections their actions are gated
 * on (`gated`, see `actionCollections`), their `manifest.sensitiveResources`
 * (`sensitive`), which of them declare neither resources nor gates, and
 * which of those have no readable manifest (`unreadable`, a subset of `silent`:
 * what they declare is unknown, not empty).
 *
 * Registers each one's `manifest.sensitiveResources` as it goes. Loading does
 * too, but a disabled extension never loads, and every path that grants on what
 * this returns — the boot reconcile, `DDLManager.createCollection` — reads it
 * first, so none of them hands out what an installed extension asked to keep
 * closed, enabled or not.
 */
async function declaredBy(
  base: string,
  installed: string[],
): Promise<{
  out: string[];
  gated: string[];
  sensitive: string[];
  silent: string[];
  unreadable: string[];
}> {
  const out: string[] = [];
  const gated: string[] = [];
  const sensitive: string[] = [];
  const silent: string[] = [];
  const unreadable: string[] = [];
  for (const name of installed) {
    const manifestPath = join(base, name, 'manifest.json');
    if (!(await Bun.file(manifestPath).exists())) {
      silent.push(name);
      unreadable.push(`${name} (no manifest.json)`);
      continue;
    }
    try {
      const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
        resources?: unknown;
        sensitiveResources?: unknown;
        actions?: unknown;
      };
      if (Array.isArray(manifest.sensitiveResources)) {
        const names = manifest.sensitiveResources.filter(
          (r): r is string => typeof r === 'string' && r !== '',
        );
        // Merged: this read may race a load of another version, which decides.
        registerSensitiveResources(name, names, { merge: true });
        sensitive.push(...names);
      }
      const declared = Array.isArray(manifest.resources)
        ? manifest.resources.filter((r): r is string => typeof r === 'string' && r !== '')
        : [];
      const onCollections = actionCollections(manifest);
      if (declared.length === 0 && onCollections.length === 0) silent.push(name);
      out.push(...declared);
      gated.push(...onCollections);
    } catch (err) {
      silent.push(name);
      unreadable.push(`${name} (${(err as Error).message})`);
      console.warn(
        `[resource-grants] ${name}: manifest.json could not be read; its resources are ` +
          'not in this reconcile:',
        (err as Error).message,
      );
    }
  }
  return { out, gated, sensitive, silent, unreadable };
}

/**
 * Every Casbin object that is not only a collection: the engine's own
 * (`ENGINE_CASBIN_OBJECTS`) and each installed extension's `manifest.resources`
 * — the declarations the boot reconcile grants on.
 *
 * Collections share the policy's object column with these. A collection may not
 * be created under one of them, and dropping a collection that already shares
 * one keeps the rules: they also guard something that is not the collection.
 *
 * Throws when the registry cannot be read, or an installed extension's
 * manifest cannot: an unknown set must refuse a name, not allow it, and must
 * not let a drop take rules it cannot attribute. That stops every collection
 * create and drop until the extension's files are back or it is uninstalled —
 * the boot reconcile, which only grants, carries on without it.
 *
 * `leaving`: the extension being purged. Its manifest is not read: its objects
 * go with it (`deleteExtensionObjectRules`), and one with no manifest left on
 * disk could otherwise never be purged.
 */
export async function nonCollectionObjects(
  db: Database,
  extensionsBase: string,
  leaving?: string,
): Promise<Set<string>> {
  const installed = (await installedExtensions(db)).filter((n) => n !== leaving);
  const { out, unreadable } = await declaredBy(extensionsBase, installed);
  if (unreadable.length > 0) {
    throw new Error(
      `Installed extension(s) without a readable manifest under ${extensionsBase}: ` +
        `${unreadable.join('; ')}. Their resources are unknown, so no collection can be ` +
        'created or dropped: restore the extension files or uninstall the extension.',
    );
  }
  return new Set([...ENGINE_CASBIN_OBJECTS, ...out, ...(await retiredZoneSlugs(db))]);
}

/**
 * Delete the `p` rules, and the revoked defaults, on extension `name`'s own
 * objects, as its purge does (extension model v3: rules on extension objects
 * are removed on purge). Resolves the rules deleted, for `forgetDeletedPolicies`
 * once the caller commits.
 *
 * Its objects: `$ext:<name>`, and the v1 `resources` and `sensitiveResources`
 * of its manifest that no collection carries and nothing else claims — another
 * extension whose data is still there, installed or soft uninstalled
 * (resources, sensitiveResources, an action's `permission.resource`), an engine
 * object, a retired zone. A collection's
 * rules are the collection's, an action-gated `execute` included: its drop
 * takes them. Role links (`g`) name no object and stay.
 *
 * Without a readable manifest only `$ext:<name>` is known, and that is said.
 * With one, throws as `nonCollectionObjects` when another such extension's
 * manifest cannot be read: what it claims is unknown, so nothing may be taken
 * from it.
 */
export async function deleteExtensionObjectRules(
  db: Database,
  extensionsBase: string,
  name: string,
): Promise<string[][]> {
  const own = await declaredBy(extensionsBase, [name]);
  if (own.unreadable.length > 0) {
    console.warn(
      `[resource-grants] purge of ${name}: ${own.unreadable.join('; ')}, so the rules on ` +
        'its v1 resources could not be identified and stay; only $ext:' +
        `${name} is removed.`,
    );
  }
  // Without its manifest there is nothing to take but `$ext:<name>`, which no
  // other extension can claim: another unreadable manifest does not refuse it.
  // It did, and two extensions without files each refused the other's purge.
  const taken =
    own.unreadable.length > 0 ? new Set<string>() : await claimedByOthers(db, extensionsBase, name);
  // A manifest is free strings: never `*` or an engine `$` object (`$edge`, `$rpc`).
  const candidates = [...new Set([...own.out, ...own.sensitive])].filter(
    (r) => r !== '*' && !r.startsWith('$') && !taken.has(r),
  );
  const collections = new Set(await existingCollections(db, candidates));
  const objects = [`$ext:${name}`, ...candidates.filter((r) => !collections.has(r))];
  await sql`DELETE FROM zv_default_grant_revocations
             WHERE resource IN (${sql.join(objects)})`.execute(db);
  const { rows } = await sql<Record<`v${0 | 1 | 2 | 3 | 4 | 5}`, string | null>>`
    DELETE FROM zvd_permissions WHERE ptype = 'p' AND v2 IN (${sql.join(objects)})
    RETURNING v0, v1, v2, v3, v4, v5`.execute(db);
  return rows.map((r) =>
    [r.v0, r.v1, r.v2, r.v3, r.v4, r.v5].filter((v): v is string => v !== null),
  );
}

/**
 * What `deleteExtensionObjectRules` may not take from `name`: the engine's
 * objects, a retired zone, and what every other extension with data left
 * claims. Throws when one of their manifests cannot be read.
 */
async function claimedByOthers(
  db: Database,
  extensionsBase: string,
  name: string,
): Promise<Set<string>> {
  const taken = await nonCollectionObjects(db, extensionsBase, name);
  const others = await declaredBy(
    extensionsBase,
    (await registeredExtensions(db)).filter((n) => n !== name),
  );
  if (others.unreadable.length > 0) {
    throw new Error(
      `Extension(s) without a readable manifest under ${extensionsBase}: ` +
        `${others.unreadable.join('; ')}. What they claim is unknown, so the purge of ` +
        `${name} takes nothing: restore their files or purge them.`,
    );
  }
  for (const r of [...others.out, ...others.gated, ...others.sensitive]) taken.add(r);
  return taken;
}

/**
 * Zone slugs, where a database upgraded from an older engine still has
 * `zvd_zones`: rules granted on a zone name it as their object, as they would a
 * collection.
 */
async function retiredZoneSlugs(db: Database): Promise<string[]> {
  const { rows } = await sql<{ present: boolean }>`
    SELECT to_regclass('public.zvd_zones') IS NOT NULL AS present`.execute(db);
  if (!rows[0]?.present) return [];
  return (await sql<{ slug: string }>`SELECT slug FROM zvd_zones`.execute(db)).rows.map(
    (r) => r.slug,
  );
}

/**
 * `manifest.resources` of every installed extension, read from disk, and the
 * existing collections their actions are gated on: the boot reconcile
 * materializes these with `{ extension: true }` on top of `listKnownResources`,
 * and the role editor offers `execute` on them.
 */
export async function listDeclaredResources(
  db: Database,
  extensionsBase: string,
): Promise<string[]> {
  const { out, gated } = await declaredOnDisk(db, extensionsBase);
  return [...new Set([...out, ...(await existingCollections(db, gated))])];
}

/**
 * The boot reconcile: default grants on every collection, and on every installed
 * extension's declared resources and action-gated collections. Collections and
 * extension resources apart: only the second get `execute`, which extension
 * actions ask for. Resolves how many rows it wrote.
 *
 * The manifests are read before anything is granted: that read registers the
 * `sensitiveResources` of every extension with a registry row, soft uninstalled
 * ones included (`registerRegisteredSensitiveResources`), and a collection one
 * of them names must not get its defaults in the first pass. Then, once per
 * database, the defaults written on those names before that are removed
 * (`repairSensitiveDefaultGrants`).
 */
export async function reconcileDefaultGrants(
  db: Database,
  extensionsBase: string,
): Promise<number> {
  const unreadable = await registerRegisteredSensitiveResources(db, extensionsBase);
  // Non-fatal: rolled back with its marker, so the next boot tries again.
  await repairSensitiveDefaultGrants(db, unreadable).catch((err: Error) => {
    console.warn('[resource-grants] sensitive default-grant repair failed:', err.message);
  });
  const declared = await listDeclaredResources(db, extensionsBase);
  return (
    (await materializeDefaultGrants(db, await listKnownResources(db))) +
    (await materializeDefaultGrants(db, declared, { extension: true }))
  );
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
  const declared = extensionsBase ? (await declaredOnDisk(db, extensionsBase)).out : [];
  return [...new Set([...collections.rows.map((r) => r.name), ...declared])];
}

/**
 * `manifest.resources` for everything installed, and the collections its actions
 * are gated on (`gated`), read from disk.
 *
 * A frozen array in engine source was once the only extension-side input this
 * reconcile had, which made it go stale by construction: an extension installed but not loaded
 * on this boot contributed nothing, and the fix was to edit engine source. The
 * declarations are already on disk and already authoritative — `register.ts`
 * materializes from the same field — so read them instead of remembering them.
 */
async function declaredOnDisk(
  db: Database,
  base: string,
): Promise<{ out: string[]; gated: string[] }> {
  const none = { out: [], gated: [] };
  // Bun.file(path).exists() returns false for directories, so stat + isDirectory
  // is the correct existence check for the extensions base path.
  try {
    const st = await Bun.file(base).stat();
    if (!st.isDirectory()) return none;
  } catch {
    return none;
  }

  let installed: string[];
  try {
    installed = await installedExtensions(db);
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
    return none;
  }

  const { out, gated, silent } = await declaredBy(base, installed);

  // Named, not counted. Deny-by-default refuses access to a resource nobody
  // granted, and the refusal carries no hint about why — so an operator whose
  // extension stopped working after an upgrade needs to read the name here.
  if (silent.length > 0) {
    console.warn(
      `[resource-grants] ${silent.length} installed extension(s) declare no ` +
        `manifest.resources and gate no action on a collection, so nothing was granted ` +
        `on them: ${silent.sort().join(', ')}. ` +
        'Update them to a build that declares resources (required since 3.0.0-beta.63).',
    );
  }
  return { out, gated };
}
