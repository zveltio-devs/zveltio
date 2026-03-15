// extensions/multitenancy/engine/routes.ts — Super-admin API for managing tenants

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { auth } from '../../../../packages/engine/src/lib/auth.js';
import { checkPermission } from '../../../../packages/engine/src/lib/permissions.js';
import {
  provisionTenantSchema,
  provisionEnvironment,
  invalidateTenantCache,
  getUserTenants,
  getTenantEnvironments,
  enableRLS,
} from '../../../../packages/engine/src/lib/tenant-manager.js';
import type { Database } from '../../../../packages/engine/src/db/index.js';

const CreateTenantSchema = z.object({
  slug: z.string().min(3).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  plan: z.enum(['free', 'pro', 'enterprise', 'custom']).default('free'),
  billing_email: z.string().email().optional(),
  admin_user_email: z.string().email(),
});

const CreateEnvironmentSchema = z.object({
  slug: z.string().min(2).max(30).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
});

export function tenantsRoutes(db: Database, _auth: any): Hono {
  const router = new Hono();

  // Auth guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user' as any, session.user);
    await next();
  });

  // GET /api/tenants — list all tenants (super-admin only)
  router.get('/', async (c) => {
    const user = (c as any).get('user');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const tenants = await (db as any)
      .selectFrom('zv_tenants')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();

    return c.json({ tenants });
  });

  // GET /api/tenants/me — current user's tenants
  router.get('/me', async (c) => {
    const user = (c as any).get('user');
    const tenants = await getUserTenants(user.id);
    return c.json({ tenants });
  });

  // POST /api/tenants — create new tenant
  router.post('/', zValidator('json', CreateTenantSchema), async (c) => {
    const user = (c as any).get('user');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const data = c.req.valid('json');

    const tenant = await (db as any)
      .insertInto('zv_tenants')
      .values({
        slug: data.slug,
        name: data.name,
        plan: data.plan,
        billing_email: data.billing_email || null,
      })
      .returningAll()
      .executeTakeFirst();

    if (!tenant) return c.json({ error: 'Failed to create tenant' }, 500);

    // Provision default PostgreSQL schema
    const defaultSchema = `tenant_${data.slug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}`;
    await provisionTenantSchema(defaultSchema);

    // Create default environments (prod + dev)
    await provisionEnvironment(tenant.id, data.slug, 'prod', 'Production', true);
    await provisionEnvironment(tenant.id, data.slug, 'dev', 'Development', false);

    // Add admin user to tenant
    const adminUser = await (db as any)
      .selectFrom('user')
      .select('id')
      .where('email', '=', data.admin_user_email)
      .executeTakeFirst();

    if (adminUser) {
      await (db as any)
        .insertInto('zv_tenant_users')
        .values({ tenant_id: tenant.id, user_id: adminUser.id, role: 'owner' })
        .execute();
    }

    return c.json(
      { tenant, default_schema: defaultSchema, environments: ['prod', 'dev'] },
      201,
    );
  });

  // PATCH /api/tenants/:id — update tenant
  router.patch('/:id', async (c) => {
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const body = await c.req.json();
    const allowed = [
      'name', 'plan', 'status', 'max_records', 'max_storage_gb',
      'max_api_calls_day', 'max_users', 'billing_email', 'settings',
    ];
    const updateData: Record<string, any> = { updated_at: new Date() };
    for (const key of allowed) {
      if (body[key] !== undefined) updateData[key] = body[key];
    }

    const updated = await (db as any)
      .updateTable('zv_tenants')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!updated) return c.json({ error: 'Tenant not found' }, 404);
    await invalidateTenantCache(updated.slug, updated.id);

    return c.json({ tenant: updated });
  });

  // GET /api/tenants/:id/usage — usage stats (last 30 days)
  router.get('/:id/usage', async (c) => {
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const usage = await (db as any)
      .selectFrom('zv_tenant_usage')
      .selectAll()
      .where('tenant_id', '=', id)
      .orderBy('date', 'desc')
      .limit(30)
      .execute();

    return c.json({ usage });
  });

  // GET /api/tenants/:id/environments — list environments
  router.get('/:id/environments', async (c) => {
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');

    if (!isSuperAdmin) {
      const membership = await (db as any)
        .selectFrom('zv_tenant_users')
        .select('role')
        .where('tenant_id', '=', id)
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
    }

    const environments = await getTenantEnvironments(id);
    return c.json({ environments });
  });

  // POST /api/tenants/:id/enable-rls/:collection — enable RLS on a collection table
  router.post('/:id/enable-rls/:collection', async (c) => {
    const user = (c as any).get('user');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const collection = c.req.param('collection');
    // Collections are stored in zvd_ prefixed tables
    const tableName = collection.startsWith('zvd_') ? collection : `zvd_${collection}`;

    try {
      await enableRLS(tableName);
      return c.json({ success: true, table: tableName, rls: 'enabled' });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // POST /api/tenants/:id/environments — create new environment (e.g. staging)
  router.post('/:id/environments', zValidator('json', CreateEnvironmentSchema), async (c) => {
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');
    if (!isSuperAdmin) return c.json({ error: 'Forbidden' }, 403);

    const { slug, name } = c.req.valid('json');

    const tenant = await (db as any)
      .selectFrom('zv_tenants')
      .select(['id', 'slug'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    await provisionEnvironment(tenant.id, tenant.slug, slug, name, false);

    const schemaName = `tenant_${tenant.slug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}_${slug}`;
    return c.json({ success: true, schema: schemaName }, 201);
  });

  return router;
}
