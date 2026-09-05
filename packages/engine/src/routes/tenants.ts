import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auditLog } from '../lib/audit.js';
// requireInstanceAdmin, not checkPermission: every route here is instance-level
// administration (create/suspend tenants, move members between them). The old
// gate asked for ('tenants','manage'), but the tenant_admin policy is
// ('*','*','*'), so any delegated tenant admin matched it — and the member
// routes take the tenant id from the URL without checking it is the caller's,
// so a tenant admin could make themselves owner of any other tenant.
import {
  getEnforcer,
  invalidateUserPermCache,
  requireInstanceAdmin,
} from '../lib/tenancy/index.js';
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

/** Thrown inside the create transaction so the tenant insert rolls back. */
class MissingTenantAdminError extends Error {}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
export function tenantsRoutes(db: Database, auth: any): Hono {
  const router = new Hono();

  // Auth guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'Unauthorized' }, 401);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    c.set('user' as any, session.user);
    await next();
  });

  // GET /api/tenants — list all tenants (super-admin only)
  router.get('/', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const tenants = await db
      .selectFrom('zv_tenants')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();

    return c.json({ tenants });
  });

  // GET /api/tenants/me — the units this person may stand in.
  //
  // This is the question a unit switcher asks, and it is not the one `GET /`
  // answers: that route is instance-admin only AND is itself scoped by RLS, so
  // it reports "which units exist inside the unit I am already in" — one,
  // always.
  //
  // An instance administrator gets every unit. They are the person who most
  // needs to move between units and, by construction, a member of none:
  // `zv_tenant_users` holds assignments, and a god user bypasses tenancy rather
  // than being enrolled in it. Answering from assignments alone returned an
  // empty list to exactly the caller this endpoint exists for.
  router.get('/me', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (await requireInstanceAdmin(user.id)) {
      const all = await sql<{
        id: string;
        name: string;
        slug: string;
        parent_id: string | null;
      }>`SELECT id, name, slug, parent_id FROM zv_tenants
          WHERE closed_at IS NULL ORDER BY name`.execute(db);
      return c.json({ tenants: all.rows });
    }
    const tenants = await getUserTenants(user.id);
    return c.json({ tenants });
  });

  // POST /api/tenants — create new tenant
  router.post('/', zValidator('json', CreateTenantSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const data = c.req.valid('json');

    // The tenant and its owner's membership go in together.
    //
    // A tenant row with no membership is a tenant NOBODY can reach: every route
    // is scoped by membership, so the person it was created for cannot open it
    // to fix it, and only an instance admin querying the table directly would
    // ever find out it exists. Ordering matters as much as atomicity here, which
    // is why the membership is written before provisioning rather than after —
    // a tenant that is reachable but missing an environment can be repaired by
    // the owner; the other way round cannot.
    const createTenantWithOwner = () =>
      db.transaction().execute(async (trx) => {
        const tenant = await trx
          .insertInto('zv_tenants')
          .values({
            slug: data.slug,
            name: data.name,
            plan: data.plan,
            billing_email: data.billing_email || null,
          })
          .returningAll()
          .executeTakeFirst();
        if (!tenant) return null;

        const adminUser = await trx
          .selectFrom('user')
          .select('id')
          .where('email', '=', data.admin_user_email)
          .executeTakeFirst();

        // No owner, no tenant. The comment above says an unreachable tenant is
        // the failure to avoid — and this used to create one: `admin_user_email`
        // is validated as an email, never as a user that exists, so a typo
        // produced a tenant with no membership, no Casbin role, and a 201 saying
        // it had worked. Nobody could open it, and only somebody querying
        // `zv_tenants` directly would ever learn it was there.
        //
        // Refusing is the whole fix: a company is created together with the
        // person who administers it, or not at all.
        // THROW, not return. A `return` out of `db.transaction().execute()`
        // COMMITS — the insert above would stay, and the first version of this
        // fix did exactly that: it answered 400 and left the unreachable tenant
        // behind, which is the whole failure it was written to prevent. The test
        // caught it because it checks the table, not just the status code.
        if (!adminUser) throw new MissingTenantAdminError();

        await trx
          .insertInto('zv_tenant_users')
          .values({ tenant_id: tenant.id, user_id: adminUser.id, role: 'owner' })
          .execute();

        return { tenant, adminUserId: adminUser.id };
      });

    let created: Awaited<ReturnType<typeof createTenantWithOwner>>;
    try {
      created = await createTenantWithOwner();
    } catch (e) {
      if (e instanceof MissingTenantAdminError) {
        return c.json(
          {
            error:
              `No user with email "${data.admin_user_email}". A company is created together with ` +
              'the person who administers it — create that user first, then create the company.',
          },
          400,
        );
      }
      // Duplicate slug is a client error — Bun's SQL driver reports the
      // Postgres SQLSTATE in `errno` (23505 = unique_violation), not `code`.
      if (String((e as { errno?: string | number }).errno) === '23505') {
        return c.json({ error: `A tenant with slug "${data.slug}" already exists` }, 409);
      }
      throw e;
    }

    if (!created) return c.json({ error: 'Failed to create tenant' }, 500);
    const { tenant, adminUserId } = created;

    const defaultSchema = `tenant_${data.slug.replace(/[^a-z0-9_]/g, '_').toLowerCase()}`;
    await provisionTenantSchema(defaultSchema);
    await provisionEnvironment(tenant.id, data.slug, 'prod', 'Production', true);
    await provisionEnvironment(tenant.id, data.slug, 'dev', 'Development', false);

    if (adminUserId) {
      // Bridge to authorization: grant the Casbin `owner` role IN this tenant's
      // domain so the owner actually has per-tenant permissions (not just a
      // membership row). The owner role's permissions are global policies.
      //
      // Outside the transaction on purpose: Casbin writes through its own
      // adapter and would not roll back with us, so pretending it is part of
      // the same commit would be a lie. Membership is the durable fact; the
      // role grant is derived from it and re-grantable.
      const e = await getEnforcer();
      await e.addRoleForUser(adminUserId, casbinRole('owner'), tenant.id);
      await invalidateUserPermCache(adminUserId);
      await invalidateTenantCache(data.slug, tenant.id, adminUserId);
    }

    await auditLog(db, {
      type: 'tenant.created',
      userId: user?.id,
      resourceId: tenant.id,
      resourceType: 'tenant',
      metadata: { slug: data.slug, name: data.name, owner_user_id: adminUserId ?? null },
    });

    return c.json({ tenant, default_schema: defaultSchema, environments: ['prod', 'dev'] }, 201);
  });

  // PATCH /api/tenants/:id — update tenant
  router.patch('/:id', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await requireInstanceAdmin(user.id))) {
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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

    // The field NAMES, and the status when it moved. `status` is the one that
    // decides whether every request for this firm is answered at all, so a
    // suspension should be answerable from the trail rather than inferred from
    // the row's current value.
    await auditLog(db, {
      type: 'tenant.updated',
      userId: user?.id,
      resourceId: id,
      resourceType: 'tenant',
      metadata: {
        fields: Object.keys(updateData).filter((k) => k !== 'updated_at'),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });

    return c.json({ tenant: updated });
  });

  // GET /api/tenants/:id/usage — usage stats (last 30 days)
  router.get('/:id/usage', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await requireInstanceAdmin(user.id))) {
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await requireInstanceAdmin(user.id);

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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const collection = c.req.param('collection');
    const tableName = collection.startsWith('zvd_') ? collection : `zvd_${collection}`;

    try {
      await enableRLS(tableName);
      await auditLog(db, {
        type: 'tenant.rls_enabled',
        userId: user?.id,
        resourceId: tableName,
        resourceType: 'collection',
        metadata: { tenant_id: c.req.param('id'), collection },
      });
      return c.json({ success: true, table: tableName, rls: 'enabled' });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // POST /api/tenants/:id/environments — create new environment
  router.post('/:id/environments', zValidator('json', CreateEnvironmentSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await requireInstanceAdmin(user.id))) {
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
    await auditLog(db, {
      type: 'tenant.updated',
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'tenant_environment',
      metadata: { schema: schemaName },
    });

    return c.json({ success: true, schema: schemaName }, 201);
  });

  // ── Membership + per-tenant roles ──────────────────────────────────────────
  // The control plane for per-tenant RBAC: a member's `role` is also granted as
  // a Casbin role IN the tenant's domain, so the same user can be e.g. admin in
  // tenant A and viewer in tenant B. Role PERMISSIONS are global policies
  // (managed via /api/permissions); membership scopes WHICH tenant they apply in.

  // GET /api/tenants/:id/members — list members (user + per-tenant role)
  router.get('/:id/members', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
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

    await auditLog(db, {
      type: 'tenant.member_added',
      userId: user.id,
      resourceId: target.id,
      resourceType: 'tenant_member',
      metadata: { tenant_id: tenantId, tenant_slug: tenant.slug, role, user_email },
    });

    return c.json({ success: true, user_id: target.id, role }, 201);
  });

  // DELETE /api/tenants/:id/members/:userId — remove a member + their per-tenant roles
  router.delete('/:id/members/:userId', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
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

    await auditLog(db, {
      type: 'tenant.member_removed',
      userId: user.id,
      resourceId: targetId,
      resourceType: 'tenant_member',
      metadata: { tenant_id: tenantId, tenant_slug: tenant?.slug ?? null },
    });

    return c.json({ success: true });
  });

  return router;
}
