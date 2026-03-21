import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Extend Hono's ContextVariableMap so c.set/c.get('adminUser') pass type-checking.
declare module 'hono' {
  interface ContextVariableMap {
    adminUser: any;
  }
}
import type { Database } from '../db/index.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  invalidateUserPermCache,
} from '../lib/permissions.js';
import { auditLog } from '../lib/audit.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function permissionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Store admin user in context so handlers can access it for audit logging.
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('adminUser', user);
    await next();
  });

  // GET / — List all policies
  app.get('/', async (c) => {
    const policies = await db
      .selectFrom('zvd_permissions' as any)
      .selectAll()
      .orderBy('ptype' as any)
      .orderBy('v0' as any)
      .execute();
    return c.json({ policies });
  });

  // GET /roles/:userId — Get roles for a user
  app.get('/roles/:userId', async (c) => {
    const roles = await getUserRoles(c.req.param('userId'));
    return c.json({ roles });
  });

  // POST /roles — Assign role to user
  app.post(
    '/roles',
    zValidator(
      'json',
      z.object({
        userId: z.string(),
        role: z.string(),
      }),
    ),
    async (c) => {
      const { userId, role } = c.req.valid('json');
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.addRoleForUser(userId, role);
      await invalidateUserPermCache(userId);
      // F2 FIX: Audit trail for role assignment.
      auditLog(db, {
        type: 'user.role_changed',
        userId: admin?.id,
        resourceId: userId,
        resourceType: 'user',
        metadata: { action: 'role_assigned', role },
      }).catch(() => {});
      return c.json({ success: true, userId, role });
    },
  );

  // DELETE /roles — Remove role from user
  app.delete(
    '/roles',
    zValidator(
      'json',
      z.object({
        userId: z.string(),
        role: z.string(),
      }),
    ),
    async (c) => {
      const { userId, role } = c.req.valid('json');
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.deleteRoleForUser(userId, role);
      await invalidateUserPermCache(userId);
      // F2 FIX: Audit trail for role removal.
      auditLog(db, {
        type: 'user.role_changed',
        userId: admin?.id,
        resourceId: userId,
        resourceType: 'user',
        metadata: { action: 'role_removed', role },
      }).catch(() => {});
      return c.json({ success: true });
    },
  );

  // POST /policies — Add a policy
  app.post(
    '/policies',
    zValidator(
      'json',
      z.object({
        subject: z.string(),
        resource: z.string(),
        action: z.string(),
      }),
    ),
    async (c) => {
      const { subject, resource, action } = c.req.valid('json');
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.addPolicy(subject, resource, action);
      await invalidateAllPermissionCache();
      // F2 FIX: Audit trail for policy creation.
      auditLog(db, {
        type: 'permission.granted',
        userId: admin?.id,
        resourceType: 'policy',
        metadata: { subject, resource, effect: action },
      }).catch(() => {});
      return c.json({ success: true });
    },
  );

  // DELETE /policies — Remove a policy
  app.delete(
    '/policies',
    zValidator(
      'json',
      z.object({
        subject: z.string(),
        resource: z.string(),
        action: z.string(),
      }),
    ),
    async (c) => {
      const { subject, resource, action } = c.req.valid('json');
      const admin = c.get('adminUser') as any;
      const e = await getEnforcer();
      await e.removePolicy(subject, resource, action);
      await invalidateAllPermissionCache();
      // F2 FIX: Audit trail for policy removal.
      auditLog(db, {
        type: 'permission.revoked',
        userId: admin?.id,
        resourceType: 'policy',
        metadata: { subject, resource, effect: action },
      }).catch(() => {});
      return c.json({ success: true });
    },
  );

  // POST /cache/invalidate — Manual cache invalidation
  app.post('/cache/invalidate', async (c) => {
    await invalidateAllPermissionCache();
    return c.json({ success: true, message: 'Permission cache invalidated' });
  });

  return app;
}

// F2 FIX: Replace O(N) blocking KEYS command with non-blocking SCAN iteration.
// KEYS scans every key in the Redis keyspace and blocks the server for the duration —
// prohibited in production. SCAN iterates in batches without blocking.
async function invalidateAllPermissionCache() {
  const { getCache } = await import('../lib/cache.js');
  const cache = getCache();
  if (!cache) return;
  try {
    const allKeys: string[] = [];
    for (const pattern of ['perm:*', 'roles:*', 'god:*', 'user:perm-keys:*']) {
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
