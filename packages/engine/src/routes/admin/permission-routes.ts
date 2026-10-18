import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getEnforcer,
  invalidateAllPermissionCaches,
  reconcilePolicies,
  deleteRole,
  ENGINE_SEEDED_ROLES,
} from '../../lib/tenancy/index.js';
import { invalidateColumnPermCache, listDeclaredResources } from '../../lib/tenancy/index.js';
import { resolveExtensionsBase } from '../../lib/extensions/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { withoutAuthValue } from '../../lib/virtual-collection-adapter.js';
import { tenantId } from '../../lib/route-db.js';
import { auditLog } from '../../lib/audit.js';
import { recordSchemaMigration } from '../../lib/schema-artifact/dev-writer.js';
import type { RequestUser } from '../data.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';

/**
 * Admin RBAC routes — the Studio permissions matrix backend (collections,
 * resources, roles, permissions, role hierarchy). Extracted from admin.ts
 * (H-07 split). Route paths are byte-identical.
 */
export function registerPermissionRoutes(app: Hono, db: Database): void {
  // ── Permissions UI helpers ────────────────────────────────────
  // These endpoints back the Studio permissions matrix page.

  // GET /collections — Collections list (for permission matrix columns)
  app.get('/collections', async (c) => {
    // The upstream credential is write-only (`withoutAuthValue`).
    const collections = (await DDLManager.getCollections(db)).map((col) => ({
      ...col,
      virtual_config: withoutAuthValue(col.virtual_config),
    }));
    return c.json({ collections });
  });

  // GET /resources — All permission-addressable resources: collections + zones.
  // Collections use actions: view, create, update, delete.
  // Zones use actions: read, write (portal/intranet access model).
  app.get('/resources', async (c) => {
    const collections = await DDLManager.getCollections(db);

    // Zones are RETIRED, so this reads the table only where one still exists.
    // `content/zones` was never a real extension name; the portal architecture
    // became `content/pages`, which migrates out of `zvd_zones` rather than
    // keeping it. The engine no longer creates the table either, so on every
    // install made from here on the list is empty — which is correct. Only a
    // database upgraded from an older engine still has rows to offer.
    //
    // The table is checked for, not queried and caught: the request runs in a
    // transaction, and a SELECT on a missing table (42P01) aborts it, so every
    // statement after it — the extension resources below — failed too.
    let zones: Array<{ slug: string; name: string }> = [];
    const hasZones = await sql<{ ok: boolean }>`
      SELECT to_regclass('public.zvd_zones') IS NOT NULL AS ok
    `.execute(db);
    if (hasZones.rows[0]?.ok) {
      zones = (
        await sql<{ slug: string; name: string }>`
          SELECT slug, name FROM zvd_zones ORDER BY name ASC
        `.execute(db)
      ).rows;
    }
    const collectionNames = new Set(collections.map((col) => col.name));
    const resources = [
      ...collections.map((col) => ({
        name: col.name,
        display_name: col.display_name || col.name,
        type: 'collection' as const,
        // The names the data handlers ask Casbin for. This said `view`, which no
        // check asks for: every tick of it granted nothing (migration 015).
        actions: ['read', 'create', 'update', 'delete'],
      })),
      // What installed extensions declare in `manifest.resources`, other than a
      // collection already listed above (CRM declares its own collections). An
      // extension route asks for these, and an extension action asks `execute`,
      // which tenant_member holds by default: without this section the matrix
      // could neither show nor revoke it.
      ...(await listDeclaredResources(db, resolveExtensionsBase()))
        .filter((name) => !collectionNames.has(name))
        .sort()
        .map((name) => ({
          name,
          display_name: name,
          type: 'extension' as const,
          actions: ['read', 'create', 'update', 'delete', 'execute'],
        })),
      ...zones.map((z) => ({
        name: z.slug,
        display_name: z.name,
        type: 'zone' as const,
        actions: ['read', 'write'],
      })),
    ];
    return c.json({ resources });
  });

  // GET /roles — List custom roles
  app.get('/roles', async (c) => {
    const roles = await db.selectFrom('zv_roles').selectAll().orderBy('name', 'asc').execute();
    return c.json({ roles });
  });

  // POST /roles — Create a custom role
  app.post(
    '/roles',
    zValidator(
      'json',
      z.object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z][a-z0-9_-]*$/, 'Role name must be lowercase letters, digits, _ or -'),
        description: z.string().optional(),
      }),
    ),
    async (c) => {
      const { name, description } = c.req.valid('json');
      const existing = await db
        .selectFrom('zv_roles')
        .where('name', '=', name)
        .selectAll()
        .executeTakeFirst();
      if (existing) return c.json({ error: `Role "${name}" already exists` }, 409);
      const role = await db
        .insertInto('zv_roles')
        .values({ name, description: description ?? null })
        .returningAll()
        .executeTakeFirst();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'permission.granted',
        tenantId: null,
        userId: user?.id,
        resourceId: role?.id,
        resourceType: 'role',
        metadata: { name, description },
      });
      return c.json({ role }, 201);
    },
  );

  // DELETE /roles/:id — Delete a custom role and its Casbin policies
  //
  // `:id` is a zv_roles uuid, and the pattern says so. Unconstrained, this route
  // (registered first) also matched `DELETE /roles/hierarchy`, cast `hierarchy`
  // to uuid, and answered 400 — removing an inheritance edge was unreachable.
  app.delete('/roles/:id{[0-9a-fA-F-]{36}}', async (c) => {
    const id = c.req.param('id');
    const role = await db
      .selectFrom('zv_roles')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst();
    if (!role) return c.json({ error: 'Role not found' }, 404);
    // `client`, `employee` and `manager` are seeded with a zv_roles row, and
    // the intranet and client portal grant through them; nothing seeds them
    // again once gone. The tenant roles can be given a row by POST /roles.
    // Either way, deleting one strips every holder in every tenant. A role an
    // instance does not want is left unassigned instead.
    if (ENGINE_SEEDED_ROLES.includes(role.name)) {
      return c.json({ error: `${role.name} is a built-in role and cannot be deleted` }, 409);
    }

    await deleteRole(db, role.name);
    recordSchemaMigration({ op: 'dropRole', role: role.name });
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.revoked',
      tenantId: null,
      userId: user?.id,
      resourceId: id,
      resourceType: 'role',
      metadata: { name: role.name },
    });
    return c.json({ success: true });
  });

  // GET /permissions — All custom-role permissions (ptype='p' from zvd_permissions)
  app.get('/permissions', async (c) => {
    const roles = await db.selectFrom('zv_roles').selectAll().execute();
    const roleNameToId = new Map<string, string>(roles.map((r) => [r.name, r.id]));

    const policies = await db
      .selectFrom('zvd_permissions')
      .selectAll()
      .where('ptype', '=', 'p')
      // The matrix edits global rules only, and bulk saves what it shows as
      // domain '*': a tenant's rule listed here came back from a save global.
      .where('v1', '=', '*')
      .execute();

    const permissions = policies
      .filter((p) => roleNameToId.has(p.v0))
      .map((p) => ({
        role_id: roleNameToId.get(p.v0),
        // `bulk` below writes `(role, '*', resource, action)`: v1 is the DOMAIN,
        // v2 the resource, v3 the action. Reading v1/v2 handed the screen
        // resource `*` and the collection name as the action — every saved box
        // came back unticked, and the next save sent `action: '<collection>'`,
        // which the enum refuses with 400. One grant made the screen unsavable.
        resource: p.v2,
        action: p.v3,
      }));

    return c.json({ permissions });
  });

  // POST /permissions/bulk — Replace every role's permissions with the posted set
  app.post(
    '/permissions/bulk',
    zValidator(
      'json',
      z.object({
        permissions: z.array(
          z.object({
            role_id: z.string().uuid(),
            resource: z.string().min(1),
            // `execute` is what an extension action asks for: a role holding it,
            // granted elsewhere, comes back from GET /permissions and is saved back.
            action: z.enum(['view', 'create', 'update', 'delete', 'read', 'write', 'execute', '*']),
          }),
        ),
      }),
    ),
    async (c) => {
      const { permissions } = c.req.valid('json');
      const roles = await db.selectFrom('zv_roles').selectAll().execute();
      const roleIdToName = new Map<string, string>(roles.map((r) => [r.id, r.name]));

      const e = await getEnforcer();

      // The posted set per role, as rules. `view` is what this screen used to
      // offer; it means `read` (see /resources). Domain '*' = global (applies
      // in every tenant). A rule for a role with no row is dropped, as before.
      const wanted = new Map<string, Set<string>>(roles.map((r) => [r.name, new Set<string>()]));
      for (const perm of permissions) {
        const roleName = roleIdToName.get(perm.role_id);
        if (!roleName) continue;
        const action = perm.action === 'view' ? 'read' : perm.action;
        wanted.get(roleName)!.add(JSON.stringify([roleName, '*', perm.resource, action]));
      }

      // A diff, not delete-all-then-add: an unchanged rule is never touched, so a
      // save that dies half-way cannot leave every default grant removed — and
      // recorded as revoked by the adapter, which would outlive the next boot.
      // A default the save omits is removed (and stays revoked); one it adds back
      // is re-added (and its revocation cleared).
      for (const [roleName, keep] of wanted) {
        // Domain '*' only, as GET /permissions lists: a tenant's rule for the
        // role is not on the screen, so a save neither drops nor globalizes it.
        const have = new Set(
          (await e.getFilteredPolicy(0, roleName, '*')).map((r) => JSON.stringify(r)),
        );
        for (const rule of have) {
          if (!keep.has(rule)) await e.removePolicy(...(JSON.parse(rule) as string[]));
        }
        for (const rule of keep) {
          if (!have.has(rule)) await e.addPolicy(...(JSON.parse(rule) as string[]));
        }
      }

      await invalidateAllPermissionCaches();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'permission.granted',
        tenantId: null,
        userId: user?.id,
        resourceType: 'permissions_bulk',
        metadata: { count: permissions.length },
      });
      return c.json({ success: true });
    },
  );

  // ── Role Hierarchy (Casbin `g` role-role inheritance) ────────
  //
  // Casbin supports: g, child_role, parent_role
  // Example: g, manager, employee  → manager inherits all employee perms
  //
  // This enables RBAC hierarchies like:
  //   god → admin → manager → employee
  //
  // The UI can visualize this as an inheritance tree and let admins
  // define which roles inherit from which others.

  // GET /roles/hierarchy — All role-role inheritance edges
  app.get('/roles/hierarchy', async (c) => {
    // No `.catch(() => [])`. An empty list here renders as "no role inherits from
    // any other", which an administrator reads off the inheritance tree and acts on
    // — granting directly what a parent role already confers, or removing a role in
    // the belief nothing depends on it. A 500 says the tree could not be drawn,
    // which is the only honest answer when it could not be read.
    //
    // A role edge and a user's role assignment are the same row shape —
    // `('g', child_role, parent_role, '*')` and `('g', user_id, role, '*')` — so
    // the only thing that tells them apart is whether v0 names a user. This used
    // to test v0 against a UUID regex, but better-auth ids are 32-char
    // alphanumerics: every user assignment was listed as an edge, and its delete
    // button revoked that user's role. Domain `*` is the only one POST writes and
    // DELETE removes; `child = parent` is the seeded `('g','admin','admin')`
    // placeholder, which POST refuses and which is not inheritance.
    const hierarchy = await db
      .selectFrom('zvd_permissions as g')
      .select(['g.v0 as child', 'g.v1 as parent'])
      .where('g.ptype', '=', 'g')
      .where('g.v2', '=', '*')
      .whereRef('g.v0', '<>', 'g.v1')
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('user').select('user.id').whereRef('user.id', '=', 'g.v0'))),
      )
      .execute();

    return c.json({ hierarchy });
  });

  // POST and DELETE below manage role-to-role edges only. With a user id as
  // `child` they would grant or revoke that user's role while the audit trail
  // records a hierarchy change; role assignment has its own routes.
  const isUserId = async (id: string) =>
    (await db.selectFrom('user').select('id').where('id', '=', id).executeTakeFirst()) !==
    undefined;
  const notARole = { error: '"child" is a user, not a role' };

  // POST /roles/hierarchy — Add inheritance: child_role inherits parent_role
  app.post(
    '/roles/hierarchy',
    zValidator(
      'json',
      z.object({
        child: z.string().min(1),
        parent: z.string().min(1),
      }),
    ),
    async (c) => {
      const { child, parent } = c.req.valid('json');
      if (child === parent) return c.json({ error: 'A role cannot inherit from itself' }, 400);
      if (await isUserId(child)) return c.json(notARole, 400);

      const e = await getEnforcer();
      // Circular inheritance, at any depth.
      //
      // This used to ask `getRolesForUser(parent)` — the roles the parent holds
      // DIRECTLY — which catches `A inherits B` followed by `B inherits A` and
      // nothing longer. Measured: with A→B and B→C already in place, closing the
      // loop with C→A was allowed, and casbin then resolved A's implicit roles
      // as [B, C, A].
      //
      // The consequence is not a crash; casbin walks a cycle without looping.
      // It is that every role in the loop silently acquires every other role's
      // permissions, while the inheritance tree the administrator reads shows
      // three ordinary edges and says nothing about the loop they close.
      //
      // `getImplicitRolesForUser` resolves the whole chain, so it refuses a loop
      // of any length. Checked that it does not over-refuse: a fresh `D inherits
      // A`, which closes nothing, stays allowed.
      const parentRoles = await e.getImplicitRolesForUser(parent, '*');
      if (parentRoles.includes(child)) {
        return c.json(
          { error: `Circular inheritance: "${parent}" already inherits from "${child}"` },
          409,
        );
      }
      await e.addRoleForUser(child, parent, '*');
      await invalidateAllPermissionCaches();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'permission.granted',
        tenantId: null,
        userId: user?.id,
        resourceType: 'role_hierarchy',
        metadata: { child, parent, action: 'added' },
      });
      return c.json({ success: true, child, parent });
    },
  );

  // DELETE /roles/hierarchy — Remove inheritance
  app.delete(
    '/roles/hierarchy',
    zValidator(
      'json',
      z.object({
        child: z.string().min(1),
        parent: z.string().min(1),
      }),
    ),
    async (c) => {
      const { child, parent } = c.req.valid('json');
      if (await isUserId(child)) return c.json(notARole, 400);
      const e = await getEnforcer();
      await e.deleteRoleForUser(child, parent, '*');
      await invalidateAllPermissionCaches();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'permission.revoked',
        tenantId: null,
        userId: user?.id,
        resourceType: 'role_hierarchy',
        metadata: { child, parent, action: 'removed' },
      });
      return c.json({ success: true });
    },
  );

  // ── Orphaned Casbin rows ─────────────────────────────────────
  //
  // Users deleted by SCIM, GDPR erasure or raw SQL before migration 017's
  // trigger left their `g`/`p` rows, with no `user.deleted` audit row for 017
  // to prune them by. Nothing can tell those ids apart from roles except the
  // negative evidence below, so this lists candidates and an operator confirms.
  //
  // No tenant filter: `zvd_permissions` is a global table and the admin guard
  // is `requireInstanceAdmin`, which only a god or a root-tenant admin passes —
  // the "platform admin" every tenant-scoped sibling exempts.
  const ORPHAN_REASON =
    'subject is not a user, not a zv_roles role, not the role of any g row, and not engine-seeded';
  const orphanKey = (ptype: string, rule: string[]) => JSON.stringify([ptype, ...rule]);
  const findOrphans = async (subjects?: string[]) => {
    let q = db
      .selectFrom('zvd_permissions as p')
      .select(['p.ptype', 'p.v0', 'p.v1', 'p.v2', 'p.v3', 'p.v4', 'p.v5'])
      .where('p.ptype', 'in', ['g', 'p'])
      .where('p.v0', 'not in', ENGINE_SEEDED_ROLES)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('user').select('user.id').whereRef('user.id', '=', 'p.v0'))),
      )
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('zv_roles as r').select('r.id').whereRef('r.name', '=', 'p.v0'))),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('zvd_permissions as g')
              .select('g.id')
              .where('g.ptype', '=', 'g')
              .whereRef('g.v1', '=', 'p.v0'),
          ),
        ),
      );
    if (subjects) q = q.where('p.v0', 'in', subjects);
    const rows = await q.orderBy('p.v0').orderBy('p.ptype').execute();
    return rows.map((r) => {
      const rule = [r.v0, r.v1, r.v2, r.v3, r.v4, r.v5].filter((v): v is string => v !== null);
      return {
        ptype: r.ptype as 'g' | 'p',
        rule,
        subject: r.v0,
        // p = (sub, dom, obj, act); g = (user, role, dom).
        domain: r.ptype === 'p' ? r.v1 : r.v2,
        reason: ORPHAN_REASON,
      };
    });
  };

  // GET /permissions/orphans — `g`/`p` rows whose subject is neither a user nor a known role
  app.get('/permissions/orphans', async (c) => c.json({ orphans: await findOrphans() }));

  // POST /permissions/orphans/prune — remove the rows an operator confirmed
  app.post(
    '/permissions/orphans/prune',
    zValidator(
      'json',
      z.object({
        rows: z
          .array(
            z.object({
              ptype: z.enum(['g', 'p']),
              rule: z.array(z.string().min(1)).min(2).max(6),
            }),
          )
          .min(1)
          .max(1000),
      }),
    ),
    async (c) => {
      const { rows } = c.req.valid('json');
      // The live model must hold a row for casbin to delete it: `removePolicy`
      // on a rule the model lacks returns false and never reaches the adapter.
      // A reconcile swaps in a rebuilt enforcer when the table moved — never a
      // `loadPolicy` on the live one.
      await reconcilePolicies();
      // Re-checked here, not trusted from the list: a role may have been
      // registered, or a row granted to the subject, since the operator looked.
      const still = new Set(
        (await findOrphans([...new Set(rows.map((r) => r.rule[0]!))])).map((o) =>
          orphanKey(o.ptype, o.rule),
        ),
      );
      const e = await getEnforcer();
      const user = c.get('user');
      const removed: Array<{ ptype: string; rule: string[] }> = [];
      const skipped: Array<{ ptype: string; rule: string[]; reason: string }> = [];
      for (const { ptype, rule } of rows) {
        if (!still.has(orphanKey(ptype, rule))) {
          skipped.push({ ptype, rule, reason: 'not an orphan row (any more)' });
          continue;
        }
        // Through the enforcer: its watcher publishes the removal to the other
        // replicas, the same path every permission mutation here takes.
        const ok =
          ptype === 'g' ? await e.removeGroupingPolicy(...rule) : await e.removePolicy(...rule);
        if (!ok) {
          skipped.push({ ptype, rule, reason: 'not held by the live enforcer' });
          continue;
        }
        still.delete(orphanKey(ptype, rule));
        removed.push({ ptype, rule });
        await auditLog(db, {
          type: 'permission.revoked',
          tenantId: null,
          userId: user?.id,
          resourceId: rule[0],
          resourceType: 'orphan_policy',
          metadata: { ptype, rule, reason: ORPHAN_REASON },
        });
      }
      if (removed.length > 0) await invalidateAllPermissionCaches();
      return c.json({ removed, skipped });
    },
  );
}
