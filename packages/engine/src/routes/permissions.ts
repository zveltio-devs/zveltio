import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  invalidateUserPermCache,
  invalidateAllPermissionCache,
} from '../lib/permissions.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

// Invalidate all permission cache
async function invalidateAllPermissionCache_local(): Promise<void> {
  await invalidateAllPermissionCache();
}

export function permissionsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
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
      const e = await getEnforcer();
      await e.addRoleForUser(userId, role);
      await invalidateUserPermCache(userId);
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
      const e = await getEnforcer();
      await e.deleteRoleForUser(userId, role);
      await invalidateUserPermCache(userId);
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
      const e = await getEnforcer();
      await e.addPolicy(subject, resource, action);
      await invalidateAllPermissionCache_local();
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
      const e = await getEnforcer();
      await e.removePolicy(subject, resource, action);
      await invalidateAllPermissionCache_local();
      return c.json({ success: true });
    },
  );

  // POST /cache/invalidate — Manual cache invalidation
  app.post('/cache/invalidate', async (c) => {
    await invalidateAllPermissionCache_local();
    return c.json({ success: true, message: 'Permission cache invalidated' });
  });

  return app;
}

async function invalidateAllPermissionCache() {
  const { getRedis } = await import('../lib/redis.js');
  const redis = getRedis();
  if (!redis) return;
  try {
    const keys = await redis.keys('perm:*');
    const roleKeys = await redis.keys('roles:*');
    const allKeys = [...keys, ...roleKeys];
    if (allKeys.length > 0) await redis.del(...allKeys);
  } catch { /* cache unavailable */ }
}
