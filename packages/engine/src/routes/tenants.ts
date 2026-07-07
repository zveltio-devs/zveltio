import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission, getEnforcer, invalidateUserPermCache } from '../lib/tenancy/index.js';
import {
  provisionTenantSchema,
  provisionEnvironment,
  invalidateTenantCache,
  getUserTenants,
  getTenantEnvironments,
  enableRLS,
} from '../lib/tenancy/index.js';

/** Roles a user can hold within a tenant. The Casbin role granted is
 * `tenant_<role>` (NAMESPACED so it never collides with the global `admin`/
 * `member` roles), granted in the tenant's domain. The role's PERMISSIONS are
 * global policies (migration 009); membership = "this user is <role> IN this
 * tenant", and per-tenant isolation comes from the grant's domain. */
const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
const casbinRole = (r: string) => `tenant_${r}`;
const MemberSchema = z.object({
  user_email: z.string().email(),
  role: z.enum(TENANT_ROLES).default('member'),
});

const CreateTenantSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  plan: z.enum(['free', 'pro', 'enterprise', 'custom']).default('free'),
  billing_email: z.string().email().optional(),
  admin_user_email: z.string().email(),
});

const CreateEnvironmentSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
});

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function tenantsRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  // Auth guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    c.set('user' as any, session.user);
    await next();
  });

  // GET /api/tenants — list all tenants (super-admin only)
  router.get('/', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const tenants = await db
      .selectFrom('zv_tenants')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();

    return c.json({ tenants });
  });

  // GET /api/tenants/me — current user's tenants
  router.get('/me', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const tenants = await getUserTenants(user.id);
    return c.json({ tenants });
  });

  // POST /api/tenants — create new tenant
  router.post('/', zValidator('json', CreateTenantSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const data = c.req.valid('json');

    const tenant = await db
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

    const defaultSchema = `tenant_${data.slug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}`;
    await provisionTenantSchema(defaultSchema);
    await provisionEnvironment(tenant.id, data.slug, 'prod', 'Production', true);
    await provisionEnvironment(tenant.id, data.slug, 'dev', 'Development', false);

    const adminUser = await db
      .selectFrom('user')
      .select('id')
      .where('email', '=', data.admin_user_email)
      .executeTakeFirst();

    if (adminUser) {
      await db
        .insertInto('zv_tenant_users')
        .values({ tenant_id: tenant.id, user_id: adminUser.id, role: 'owner' })
        .execute();
      // Bridge to authorization: grant the Casbin `owner` role IN this tenant's
      // domain so the owner actually has per-tenant permissions (not just a
      // membership row). The owner role's permissions are global policies.
      const e = await getEnforcer();
      await e.addRoleForUser(adminUser.id, casbinRole('owner'), tenant.id);
      await invalidateUserPermCache(adminUser.id);
      await invalidateTenantCache(data.slug, tenant.id, adminUser.id);
    }

    return c.json({ tenant, default_schema: defaultSchema, environments: ['prod', 'dev'] }, 201);
  });

  // PATCH /api/tenants/:id — update tenant
  router.patch('/:id', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json();
    const allowed = [
      'name',
      'plan',
      'status',
      'max_records',
      'max_storage_gb',
      'max_api_calls_day',
      'max_users',
      'billing_email',
      'settings',
    ];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const updateData: Record<string, any> = { updated_at: new Date() };
    for (const key of allowed) {
      if (body[key] !== undefined) updateData[key] = body[key];
    }

    const updated = await db
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const usage = await db
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await checkPermission(user.id, 'tenants', 'manage');

    if (!isSuperAdmin) {
      const membership = await db
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

  // POST /api/tenants/:id/enable-rls/:collection
  router.post('/:id/enable-rls/:collection', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collection = c.req.param('collection');
    const tableName = collection.startsWith('zvd_') ? collection : `zvd_${collection}`;

    try {
      await enableRLS(tableName);
      return c.json({ success: true, table: tableName, rls: 'enabled' });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // POST /api/tenants/:id/environments — create new environment
  router.post('/:id/environments', zValidator('json', CreateEnvironmentSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const { slug, name } = c.req.valid('json');

    const tenant = await db
      .selectFrom('zv_tenants')
      .select(['id', 'slug'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    await provisionEnvironment(tenant.id, tenant.slug, slug, name, false);

    const schemaName = `tenant_${tenant.slug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}_${slug}`;
    return c.json({ success: true, schema: schemaName }, 201);
  });

  // ── Membership + per-tenant roles ──────────────────────────────────────────
  // The control plane for per-tenant RBAC: a member's `role` is also granted as
  // a Casbin role IN the tenant's domain, so the same user can be e.g. admin in
  // tenant A and viewer in tenant B. Role PERMISSIONS are global policies
  // (managed via /api/permissions); membership scopes WHICH tenant they apply in.

  // GET /api/tenants/:id/members — list members (user + per-tenant role)
  router.get('/:id/members', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const members = await db
      .selectFrom('zv_tenant_users as tu')
      .innerJoin('user as u', 'u.id', 'tu.user_id')
      .select(['tu.user_id', 'u.email', 'u.name', 'tu.role', 'tu.joined_at'])
      .where('tu.tenant_id', '=', c.req.param('id'))
      .orderBy('tu.joined_at', 'asc')
      .execute();
    return c.json({ members });
  });

  // POST /api/tenants/:id/members — add a user to a tenant with a role
  router.post('/:id/members', zValidator('json', MemberSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const tenantId = c.req.param('id');
    const { user_email, role } = c.req.valid('json');

    const tenant = await db
      .selectFrom('zv_tenants')
      .select(['id', 'slug'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant) return c.json({ error: 'Tenant not found' }, 404);

    const target = await db
      .selectFrom('user')
      .select('id')
      .where('email', '=', user_email)
      .executeTakeFirst();
    if (!target) return c.json({ error: `No user with email ${user_email}` }, 404);

    // Upsert membership.
    await sql`
      INSERT INTO zv_tenant_users (tenant_id, user_id, role, invited_by)
      VALUES (${tenantId}, ${target.id}, ${role}, ${user.id})
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `.execute(db);

    // Bridge to Casbin: replace any prior per-tenant grant with the new role.
    const e = await getEnforcer();
    for (const r of TENANT_ROLES) await e.deleteRoleForUser(target.id, casbinRole(r), tenantId);
    await e.addRoleForUser(target.id, casbinRole(role), tenantId);
    await invalidateUserPermCache(target.id);
    await invalidateTenantCache(tenant.slug, tenantId, target.id);

    return c.json({ success: true, user_id: target.id, role }, 201);
  });

  // DELETE /api/tenants/:id/members/:userId — remove a member + their per-tenant roles
  router.delete('/:id/members/:userId', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await checkPermission(user.id, 'tenants', 'manage'))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const tenantId = c.req.param('id');
    const targetId = c.req.param('userId');

    await db
      .deleteFrom('zv_tenant_users')
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', targetId)
      .execute();

    const e = await getEnforcer();
    for (const r of TENANT_ROLES) await e.deleteRoleForUser(targetId, casbinRole(r), tenantId);
    await invalidateUserPermCache(targetId);

    const tenant = await db
      .selectFrom('zv_tenants')
      .select('slug')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant) await invalidateTenantCache(tenant.slug, tenantId, targetId);

    return c.json({ success: true });
  });

  return router;
}
