import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getEnforcer,
  invalidateAllPermissionCaches,
} from '../../lib/tenancy/index.js';
import { invalidateColumnPermCache } from '../../lib/tenancy/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { tenantId } from '../../lib/route-db.js';
import { auditLog } from '../../lib/audit.js';
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
    const collections = await DDLManager.getCollections(db);
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
    // install made from here on this query answers 42P01 and the list is empty —
    // which is correct, and is why the catch below is the normal path now rather
    // than the unusual one. Only a database upgraded from an older engine still
    // has rows to offer.
    //
    // Read defensively rather than through a service, because this endpoint
    // exists to ENUMERATE what can be granted: an extension that is present but
    // broken should cost its own rows here, not the collection list that the
    // permissions screen is mainly about.
    let zones: Array<{ slug: string; name: string }> = [];
    try {
      zones = (
        await sql<{ slug: string; name: string }>`
          SELECT slug, name FROM zvd_zones ORDER BY name ASC
        `.execute(db)
      ).rows;
    } catch (err) {
      // "The table does not exist" is the expected answer on most installs and
      // means exactly what it says: no portals to grant access to. Anything else
      // — a permission error, a timeout — is a failure, and answering it with an
      // empty list would tell an administrator there are no zones to grant when
      // there may be several.
      const code = (err as { errno?: string; code?: string }).errno ?? '';
      if (code !== '42P01') throw err;
    }
    const resources = [
      ...collections.map((col) => ({
        name: col.name,
        display_name: col.display_name || col.name,
        type: 'collection' as const,
        // The names the data handlers ask Casbin for. This said `view`, which no
        // check asks for: every tick of it granted nothing (migration 015).
        actions: ['read', 'create', 'update', 'delete'],
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

    // Remove all Casbin policies for this role name
    const e = await getEnforcer();
    await e.deletePermissionsForUser(role.name);
    await e.deleteRole(role.name);
    // And take it away from the people holding it.
    //
    // `deleteRole` removes the role's own grants — what it inherits and what it
    // may do — but not the assignments TO it, so every holder kept a membership
    // in a role that no longer exists. Harmless while the name stays gone, since
    // the permissions went with it; the moment an administrator creates a role
    // with the same name again, every old holder is silently a member of the new
    // one. A name is not an identity here, and the route says it deletes "a
    // custom role and its Casbin policies".
    await e.removeFilteredGroupingPolicy(1, role.name);

    await db.deleteFrom('zv_roles').where('id', '=', id).execute();
    await invalidateAllPermissionCaches();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.revoked',
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

  // POST /permissions/bulk — Replace all custom-role permissions atomically
  app.post(
    '/permissions/bulk',
    zValidator(
      'json',
      z.object({
        permissions: z.array(
          z.object({
            role_id: z.string().uuid(),
            resource: z.string().min(1),
            action: z.enum(['view', 'create', 'update', 'delete', 'read', 'write', '*']),
          }),
        ),
      }),
    ),
    async (c) => {
      const { permissions } = c.req.valid('json');
      const roles = await db.selectFrom('zv_roles').selectAll().execute();
      const roleIdToName = new Map<string, string>(roles.map((r) => [r.id, r.name]));

      const e = await getEnforcer();

      // Remove all existing policies for custom roles
      for (const role of roles) {
        await e.deletePermissionsForUser(role.name);
      }

      // Add new policies
      for (const perm of permissions) {
        const roleName = roleIdToName.get(perm.role_id);
        if (!roleName) continue;
        // Domain '*' = global (applies in every tenant), matching the pre-domain
        // behaviour. Per-tenant policies use a concrete tenant id instead.
        // `view` is what this screen used to offer; it means `read` (see /resources).
        const action = perm.action === 'view' ? 'read' : perm.action;
        await e.addPolicy(roleName, '*', perm.resource, action);
      }

      await invalidateAllPermissionCaches();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const user = c.get('user' as never) as any;
      await auditLog(db, {
        type: 'permission.granted',
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
        userId: user?.id,
        resourceType: 'role_hierarchy',
        metadata: { child, parent, action: 'removed' },
      });
      return c.json({ success: true });
    },
  );
}
