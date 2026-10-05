import { Hono } from 'hono';
import { sqlState } from '../db/bun-sql-quirks.js';
import { guardSession } from '../lib/admin-guard.js';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auditLog } from '../lib/audit.js';
import { storedEmail } from '../lib/auth-email.js';
// requireInstanceAdmin, not checkPermission: every route here is instance-level
// administration (create/suspend tenants, move members between them). The old
// gate asked for ('tenants','manage'), but the tenant_admin policy is
// ('*','*','*'), so any delegated tenant admin matched it — and the member
// routes take the tenant id from the URL without checking it is the caller's,
// so a tenant admin could make themselves owner of any other tenant.
import {
  activeMembership,
  DEFAULT_TENANT_ID,
  getCurrentDomain,
  getEnforcer,
  invalidateUserPermCache,
  isGodUser,
  isTenantAdmin,
  purgeTenant,
  requireInstanceAdmin,
  revalidatePrincipalsEverywhere,
  TenantPurgeRefused,
  type TenantPurgeResult,
} from '../lib/tenancy/index.js';
import { getStorage } from '../lib/storage/index.js';
import {
  invalidateRateLimitCache,
  parseTenantLimitKey,
  pickTenantLimit,
  rateLimitTiers,
  tenantAdminsMayLimit,
} from '../middleware/rate-limit.js';
import { deleteTenantlessUsers, type TenantlessUsers } from '../lib/users.js';
import {
  casbinTenantRole as casbinRole,
  grantTenantMembership,
  revokeTenantMembership,
  TENANT_ROLES,
} from '../lib/identity.js';
import {
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

const DeleteTenantSchema = z.object({
  mode: z.enum(['archive', 'purge']),
  confirm: z.string().optional(),
  // A query string carries text; a JSON body may carry either.
  delete_users: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

/** Thrown inside the create transaction so the tenant insert rolls back. */
class MissingTenantAdminError extends Error {}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function tenantsRoutes(db: Database, auth: any, poolDb: Database): Hono {
  const router = new Hono();

  // Auth guard
  router.use('*', async (c, next) => {
    const session = await guardSession(c, auth);
    if (session instanceof Response) return session;
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    c.set('user' as any, session.user);
    await next();
  });

  // GET /api/tenants — list all tenants (super-admin only)
  router.get('/', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
          .values({ slug: data.slug, name: data.name })
          .returningAll()
          .executeTakeFirst();
        if (!tenant) return null;

        const adminUser = await trx
          .selectFrom('user')
          .select('id')
          .where('email', '=', await storedEmail(trx, data.admin_user_email))
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
      if (sqlState(e) === '23505') {
        return c.json({ error: `A tenant with slug "${data.slug}" already exists` }, 409);
      }
      throw e;
    }

    if (!created) return c.json({ error: 'Failed to create tenant' }, 500);
    const { tenant, adminUserId } = created;

    // Rows only, no `tenant_<slug>[_<env>]` schemas: isolation is RLS on
    // `tenant_id`, and nothing read them. Installs from before keep theirs;
    // purge drops them.
    await provisionEnvironment(tenant.id, 'prod', 'Production', true);
    await provisionEnvironment(tenant.id, 'dev', 'Development', false);

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
      tenantId: tenant.id,
      metadata: { slug: data.slug, name: data.name, owner_user_id: adminUserId ?? null },
    });

    return c.json({ tenant, environments: ['prod', 'dev'] }, 201);
  });

  // PATCH /api/tenants/:id — update tenant
  router.patch('/:id', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    if (!(await requireInstanceAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const body = await c.req.json();
    const allowed = ['name', 'status', 'settings'];
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // A tenant no longer 'active' also ends its open sockets and streams.
    if (body.status !== undefined) revalidatePrincipalsEverywhere();

    // The field NAMES, and the status when it moved. `status` is the one that
    // decides whether every request for this firm is answered at all, so a
    // suspension should be answerable from the trail rather than inferred from
    // the row's current value.
    await auditLog(db, {
      type: 'tenant.updated',
      userId: user?.id,
      resourceId: id,
      tenantId: id,
      resourceType: 'tenant',
      metadata: {
        fields: Object.keys(updateData).filter((k) => k !== 'updated_at'),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });

    return c.json({ tenant: updated });
  });

  // DELETE /api/tenants/:id — archive or purge a tenant. God only: a purge is
  // irreversible and crosses every tenant's tables, which no delegated admin
  // role should reach. `mode` and `confirm` come from the query or a JSON body.
  //
  // archive: status 'deleted' (idempotent), data untouched, access refused by
  //   the tenant middleware; PATCH status 'active' undoes it. It does NOT
  //   cascade: child tenants keep their status and are listed in the answer.
  // purge: only an archived tenant with no child tenants, `confirm` equal to its
  //   slug. Every row it owns and the tenant row go in one transaction
  //   (lib/tenancy/tenant-purge.ts) that `purgeTenant` owns and has committed
  //   when it returns: `/api/tenants` opens no request transaction
  //   (TXN_SKIP_PREFIXES), and `purgeTenant` refuses to join one. So its media
  //   objects go after the commit, where a failure is reported and not fatal —
  //   the rows naming them are already gone. `delete_users=true` also deletes
  //   the members left in no tenant and with no grant outside it (lib/users.ts
  //   `deleteTenantlessUsers`), in a transaction of its own after the purge's,
  //   one savepoint per user.
  router.delete('/:id', async (c) => {
    const user = c.get('user' as never) as { id: string };
    if (!(await isGodUser(user.id))) return c.json({ error: 'Forbidden' }, 403);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = DeleteTenantSchema.safeParse({
      mode: c.req.query('mode') ?? body.mode,
      confirm: c.req.query('confirm') ?? body.confirm,
      delete_users: c.req.query('delete_users') ?? body.delete_users,
    });
    if (!parsed.success) {
      const onFlag = parsed.error.issues.some((i) => i.path[0] === 'delete_users');
      return c.json(
        {
          error: onFlag
            ? 'delete_users must be true or false'
            : "mode must be 'archive' or 'purge'",
        },
        400,
      );
    }
    if (parsed.data.delete_users && parsed.data.mode !== 'purge') {
      return c.json({ error: 'delete_users applies to mode=purge only' }, 400);
    }
    if (id === DEFAULT_TENANT_ID) {
      return c.json({ error: 'The default tenant cannot be archived or purged.' }, 409);
    }

    if (parsed.data.mode === 'archive') {
      const tenant = await db
        .updateTable('zv_tenants')
        .set({ status: 'deleted', updated_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      if (!tenant) return c.json({ error: 'Tenant not found' }, 404);
      await invalidateTenantCache(tenant.slug, tenant.id);
      // Its open sockets and streams too, on every instance — see `stillInTenant`.
      revalidatePrincipalsEverywhere();
      const children = await db
        .selectFrom('zv_tenants')
        .select(['id', 'slug', 'status'])
        .where('parent_id', '=', id)
        .execute();
      await auditLog(db, {
        type: 'tenant.archived',
        tenantId: id,
        userId: user.id,
        resourceId: id,
        resourceType: 'tenant',
        metadata: { slug: tenant.slug, child_tenants_unaffected: children.map((t) => t.slug) },
      });
      return c.json({ mode: 'archive', tenant, child_tenants: children });
    }

    let result: TenantPurgeResult;
    try {
      result = await purgeTenant(db, id, parsed.data.confirm);
    } catch (e) {
      if (e instanceof TenantPurgeRefused) return c.json({ error: e.message }, e.status);
      throw e;
    }
    const { slug } = result.tenant;

    const storage = getStorage();
    const files = { deleted: 0, failed: [] as string[] };
    for (const path of result.storagePaths) {
      try {
        if (!storage.isConfigured()) throw new Error('storage is not configured');
        await storage.delete(path);
        files.deleted++;
      } catch (err) {
        console.error(`[tenants] purge ${slug}: could not delete object ${path}:`, err);
        files.failed.push(path);
      }
    }

    // Grants in the tenant's domain, and every cache that still maps its slug,
    // id or members to it — a slug re-used by a new tenant must not resolve here.
    const warnings: string[] = [];
    try {
      const e = await getEnforcer();
      await e.removeFilteredGroupingPolicy(2, id);
      await e.removeFilteredPolicy(1, id);
    } catch (err) {
      warnings.push(
        `Casbin rules in the tenant's domain were not removed: ${(err as Error).message}`,
      );
    }
    await invalidateTenantCache(slug, id);
    revalidatePrincipalsEverywhere();
    for (const memberId of result.memberIds) {
      await invalidateUserPermCache(memberId);
      await invalidateTenantCache(slug, id, memberId);
    }

    let users: TenantlessUsers | undefined;
    if (parsed.data.delete_users) {
      users = await deleteTenantlessUsers(db, poolDb, result.tenant, result.memberIds, user.id);
    }

    await auditLog(db, {
      type: 'tenant.purged',
      // The tenant is gone, and its rows with it: the instance's record.
      tenantId: null,
      userId: user.id,
      resourceId: id,
      resourceType: 'tenant',
      metadata: {
        slug,
        deleted: result.deleted,
        dropped_schemas: result.droppedSchemas,
        files_deleted: files.deleted,
        files_failed: files.failed.length,
        ...(users ? { deleted_users: users.deleted, users_failed: users.failed.length } : {}),
      },
    });

    return c.json({
      mode: 'purge',
      tenant: result.tenant,
      deleted: result.deleted,
      dropped_schemas: result.droppedSchemas,
      files,
      warnings,
      ...(users ? { users } : {}),
    });
  });

  // GET /api/tenants/:id/environments — list environments
  router.get('/:id/environments', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = (c as any).get('user');
    const id = c.req.param('id');
    const isSuperAdmin = await requireInstanceAdmin(user.id);

    if (!isSuperAdmin) {
      const membership = await db
        .selectFrom('zv_tenant_users')
        .select('role')
        .where('tenant_id', '=', id)
        .where('user_id', '=', user.id)
        .where(activeMembership())
        .executeTakeFirst();
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
    }

    const environments = await getTenantEnvironments(id);
    return c.json({ environments });
  });

  // POST /api/tenants/:id/enable-rls/:collection
  router.post('/:id/enable-rls/:collection', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
        // A policy on a table every tenant shares.
        tenantId: null,
        userId: user?.id,
        resourceId: tableName,
        resourceType: 'collection',
        metadata: { tenant_id: c.req.param('id'), collection },
      });
      return c.json({ success: true, table: tableName, rls: 'enabled' });
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // POST /api/tenants/:id/environments — create new environment
  router.post('/:id/environments', zValidator('json', CreateEnvironmentSchema), async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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

    await provisionEnvironment(tenant.id, slug, name, false);
    await auditLog(db, {
      type: 'tenant.updated',
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'tenant_environment',
      tenantId: tenant.id,
      metadata: { environment: slug },
    });

    // `schema` stays for clients that read it; an environment has none since 043.
    return c.json({ success: true, schema: null }, 201);
  });

  // ── Membership + per-tenant roles ──────────────────────────────────────────
  // The control plane for per-tenant RBAC: a member's `role` is also granted as
  // a Casbin role IN the tenant's domain, so the same user can be e.g. admin in
  // tenant A and viewer in tenant B. Role PERMISSIONS are global policies
  // (managed via /api/permissions); membership scopes WHICH tenant they apply in.

  // GET /api/tenants/:id/members — list members (user + per-tenant role)
  router.get('/:id/members', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
      .where('email', '=', await storedEmail(db, user_email))
      .executeTakeFirst();
    if (!target) return c.json({ error: `No user with email ${user_email}` }, 404);

    // Upsert membership. Adding someone means "a member from now on": a row
    // that lapsed (`valid_to` passed) or has not started yet is reopened, or the
    // 201 below would describe a member every membership check refuses.
    // The Casbin grant in the tenant's domain is replaced to match.
    await grantTenantMembership(db, tenant, target.id, role, {
      invitedBy: user.id,
      reopen: true,
    });

    await auditLog(db, {
      type: 'tenant.member_added',
      tenantId,
      userId: user.id,
      resourceId: target.id,
      resourceType: 'tenant_member',
      metadata: { tenant_id: tenantId, tenant_slug: tenant.slug, role, user_email },
    });

    return c.json({ success: true, user_id: target.id, role }, 201);
  });

  // DELETE /api/tenants/:id/members/:userId — remove a member + their per-tenant roles
  router.delete('/:id/members/:userId', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = (c as any).get('user');
    if (!(await requireInstanceAdmin(user.id))) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const tenantId = c.req.param('id');
    const targetId = c.req.param('userId');

    const tenant = await db
      .selectFrom('zv_tenants')
      .select('slug')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    // Every role in this tenant's domain goes too, not only the `tenant_*` grades.
    await revokeTenantMembership(db, { id: tenantId, slug: tenant?.slug ?? null }, targetId);

    await auditLog(db, {
      type: 'tenant.member_removed',
      tenantId,
      userId: user.id,
      resourceId: targetId,
      resourceType: 'tenant_member',
      metadata: { tenant_id: tenantId, tenant_slug: tenant?.slug ?? null },
    });

    return c.json({ success: true });
  });

  // ── The request tenant's own rate limits ─────────────────────────────────
  //
  // When god allows it (`PUT /api/admin/rate-limits/tenant-admins`), a tenant's
  // admin sets `tenant-self:<tier>:<tenant>`. The limiter counts it as a second
  // bucket next to the instance's, so it can only tighten: a larger number than
  // the instance's limit changes nothing. Always the request tenant, never one
  // named in the URL.
  const ownKey = (tier: string) => `tenant-self:${tier}:${getCurrentDomain()}`;

  router.get('/current/rate-limits', async (c) => {
    const user = c.get('user' as never) as { id: string };
    if (!(await isTenantAdmin(user.id))) return c.json({ error: 'Forbidden' }, 403);
    const tenant = getCurrentDomain();
    const tiers = rateLimitTiers();
    const rows = await db
      .selectFrom('zv_rate_limit_configs')
      .select(['key_prefix', 'window_ms', 'max_requests'])
      .where('is_active', '=', true)
      .where((eb) =>
        eb.or([
          eb('key_prefix', 'like', 'tenant:%'),
          eb('key_prefix', 'like', `tenant-self:%:${tenant}`),
        ]),
      )
      .execute();
    return c.json({
      enabled: await tenantAdminsMayLimit(db),
      limits: tiers.map((tier) => {
        const own = rows.find((r) => r.key_prefix === ownKey(tier));
        return {
          tier,
          // What the instance holds this tenant to; null = no tenant limit.
          instance: pickTenantLimit(rows, tier, tenant),
          own: own ? { windowMs: own.window_ms, max: own.max_requests } : null,
        };
      }),
    });
  });

  router.put(
    '/current/rate-limits/:tier',
    zValidator(
      'json',
      z.object({
        window_ms: z.number().int().min(1000).max(3_600_000),
        max_requests: z.number().int().min(1).max(100_000),
      }),
    ),
    async (c) => {
      const user = c.get('user' as never) as { id: string };
      if (!(await isTenantAdmin(user.id))) return c.json({ error: 'Forbidden' }, 403);
      if (!(await tenantAdminsMayLimit(db))) {
        return c.json({ error: 'Rate limits are managed by the instance administrator' }, 403);
      }
      const key = ownKey(c.req.param('tier'));
      if (!parseTenantLimitKey(key, true)) return c.json({ error: 'Unknown tier' }, 400);
      const { window_ms, max_requests } = c.req.valid('json');
      await db
        .insertInto('zv_rate_limit_configs')
        .values({ key_prefix: key, window_ms, max_requests, updated_by: user.id })
        .onConflict((oc) =>
          oc
            .column('key_prefix')
            .doUpdateSet({ window_ms, max_requests, updated_by: user.id, updated_at: new Date() }),
        )
        .execute();
      await auditLog(db, {
        type: 'settings.changed',
        userId: user.id,
        resourceId: key,
        resourceType: 'rate_limit',
        metadata: { window_ms, max_requests },
      });
      invalidateRateLimitCache(key);
      return c.json({ key_prefix: key, window_ms, max_requests });
    },
  );

  router.delete('/current/rate-limits/:tier', async (c) => {
    const user = c.get('user' as never) as { id: string };
    if (!(await isTenantAdmin(user.id))) return c.json({ error: 'Forbidden' }, 403);
    if (!(await tenantAdminsMayLimit(db))) {
      return c.json({ error: 'Rate limits are managed by the instance administrator' }, 403);
    }
    const key = ownKey(c.req.param('tier'));
    if (!parseTenantLimitKey(key, true)) return c.json({ error: 'Unknown tier' }, 400);
    await db.deleteFrom('zv_rate_limit_configs').where('key_prefix', '=', key).execute();
    await auditLog(db, {
      type: 'settings.changed',
      userId: user.id,
      resourceId: key,
      resourceType: 'rate_limit',
      metadata: { removed: true },
    });
    invalidateRateLimitCache(key);
    return c.json({ success: true });
  });

  return router;
}
