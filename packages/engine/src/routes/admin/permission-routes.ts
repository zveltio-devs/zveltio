import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { checkPermission, getEnforcer } from '../../lib/permissions.js';
import { invalidateColumnPermCache } from '../../lib/column-permissions.js';
import { fieldTypeRegistry } from '../../lib/field-type-registry.js';
import { DDLManager } from '../../lib/ddl-manager.js';
import { getCache } from '../../lib/runtime/index.js';
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
    const [collections, zones] = await Promise.all([
      DDLManager.getCollections(db),
      db.selectFrom('zvd_zones').select(['slug', 'name']).orderBy('name', 'asc').execute(),
    ]);
    const resources = [
      ...collections.map((col) => ({
        name: col.name,
        display_name: col.display_name || col.name,
        type: 'collection' as const,
        actions: ['view', 'create', 'update', 'delete'],
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  app.delete('/roles/:id', async (c) => {
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

    await db.deleteFrom('zv_roles').where('id', '=', id).execute();
    await invalidatePermissionCache();
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
        resource: p.v1,
        action: p.v2,
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
        await e.addPolicy(roleName, '*', perm.resource, perm.action);
      }

      await invalidatePermissionCache();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
    const edges = await db
      .selectFrom('zvd_permissions')
      .select(['v0 as child', 'v1 as parent'])
      .where('ptype', '=', 'g')
      .execute()
      .catch(() => [] as { child: string; parent: string }[]);

    // Filter out user-role assignments (UUID v0) — keep only role-role edges
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const filtered = edges.filter((e) => !uuidRe.test(e.child));

    return c.json({ hierarchy: filtered });
  });

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

      const e = await getEnforcer();
      // Check for circular inheritance
      const parentRoles = await e.getRolesForUser(parent);
      if (parentRoles.includes(child)) {
        return c.json(
          { error: `Circular inheritance: "${parent}" already inherits from "${child}"` },
          409,
        );
      }
      await e.addRoleForUser(child, parent, '*');
      await invalidatePermissionCache();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
      const e = await getEnforcer();
      await e.deleteRoleForUser(child, parent, '*');
      await invalidatePermissionCache();
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

async function invalidatePermissionCache() {
  const cache = getCache();
  if (!cache) return;
  try {
    const allKeys: string[] = [];
    for (const pattern of ['perm:*', 'roles:*', 'god:*']) {
      let cursor = '0';
      do {
        const [nextCursor, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        allKeys.push(...batch);
      } while (cursor !== '0');
    }
    if (allKeys.length > 0) await cache.del(...allKeys);
  } catch {
    /* cache unavailable */
  }
}
