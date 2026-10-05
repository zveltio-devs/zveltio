import { type Context, Hono, type Next } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { checkPermission, getEnforcer, isGodUser } from '../../lib/tenancy/index.js';
import {
  deleteColumnPermission,
  invalidateColumnPermCache,
  putColumnPermission,
} from '../../lib/tenancy/index.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getCache } from '../../lib/runtime/index.js';
import { auditLog } from '../../lib/audit.js';
import type { RequestUser } from '../data.js';
import { toJsonb } from '../../lib/jsonb.js';
import {
  invalidateRateLimitCache,
  parseTenantLimitKey,
  rateLimitDefaults,
  rateLimitTiers,
  TENANT_ADMIN_LIMITS_SETTING,
  tenantAdminsMayLimit,
} from '../../middleware/rate-limit.js';

/**
 * Admin config routes (rate-limit configs, column-level permissions, SQL editor,
 * extensions health). Extracted from admin.ts (H-07 split). Route paths are
 * byte-identical.
 */
export function registerConfigRoutes(app: Hono, db: Database): void {
  // ── Rate Limit Configs ────────────────────────────────────────────────────

  // God only (owner decision 2026-10-05). An instance admin of the default
  // tenant used to manage every tenant's limits; a tenant's admin sets only its
  // own, tighter one, when god allows it (`/api/tenants/current/rate-limits`).
  const godOnly = async (c: Context, next: Next) => {
    const user = c.get('user') as RequestUser;
    if (!(await isGodUser(user.id))) return c.json({ error: 'Forbidden' }, 403);
    await next();
  };
  app.use('/rate-limits', godOnly);
  app.use('/rate-limits/*', godOnly);

  // GET /rate-limits — list all configurable tiers
  app.get('/rate-limits', async (c) => {
    const rows = await db
      .selectFrom('zv_rate_limit_configs')
      .selectAll()
      .orderBy('key_prefix')
      .execute();
    // `tiers`: what a `tenant:<tier>` key may name.
    return c.json({
      rate_limits: rows,
      tiers: rateLimitTiers(),
      tenant_admins_may_limit: await tenantAdminsMayLimit(db),
    });
  });

  // PUT /rate-limits/tenant-admins — may tenant admins set their own tenant's
  // limit? Turning it off removes every limit they set: none is left in force
  // that its tenant can no longer change.
  app.put(
    '/rate-limits/tenant-admins',
    zValidator('json', z.object({ enabled: z.boolean() })),
    async (c) => {
      const user = c.get('user') as RequestUser;
      const { enabled } = c.req.valid('json');
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('zv_settings')
          .values({ key: TENANT_ADMIN_LIMITS_SETTING, value: toJsonb(enabled), is_public: false })
          .onConflict((oc) =>
            oc.column('key').doUpdateSet({ value: toJsonb(enabled), updated_at: new Date() }),
          )
          .execute();
        if (!enabled) {
          await trx
            .deleteFrom('zv_rate_limit_configs')
            .where('key_prefix', 'like', 'tenant-self:%')
            .execute();
        }
        await auditLog(trx, {
          type: 'settings.changed',
          tenantId: null,
          userId: user.id,
          resourceId: TENANT_ADMIN_LIMITS_SETTING,
          resourceType: 'rate_limit',
          metadata: { enabled },
        });
      });
      invalidateRateLimitCache();
      return c.json({ tenant_admins_may_limit: enabled });
    },
  );

  // PATCH /rate-limits/:keyPrefix — update a tier
  app.patch(
    '/rate-limits/:keyPrefix',
    zValidator(
      'json',
      z.object({
        window_ms: z.number().int().min(1000).max(3_600_000).optional(),
        max_requests: z.number().int().min(1).max(100_000).optional(),
        is_active: z.boolean().optional(),
        description: z.string().optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user') as RequestUser;
      const { keyPrefix: rawKey } = c.req.param() as { keyPrefix: string };
      const body = c.req.valid('json');
      // Tenant ids are stored lowercase; an uppercase copy would be a row no
      // lookup ever matches.
      const isTenantKey = rawKey.startsWith('tenant:') || rawKey.startsWith('tenant-self:');
      const keyPrefix = isTenantKey ? rawKey.toLowerCase() : rawKey;

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
      const updates: any = { updated_at: new Date(), updated_by: user.id };
      if (body.window_ms !== undefined) updates.window_ms = body.window_ms;
      if (body.max_requests !== undefined) updates.max_requests = body.max_requests;
      if (body.is_active !== undefined) updates.is_active = body.is_active;
      if (body.description !== undefined) updates.description = body.description;

      // Tenant limits have no seeded row — absent means off — so PATCH creates
      // one. The key is validated first: a typo would otherwise create a row no
      // limiter ever reads, and the operator would believe the limit applies.
      if (isTenantKey && !parseTenantLimitKey(keyPrefix) && !parseTenantLimitKey(keyPrefix, true)) {
        return c.json(
          {
            error: 'Invalid tenant rate limit key',
            detail: `Expected tenant:<tier>, tenant:<tier>:<tenant uuid> or tenant-self:<tier>:<tenant uuid>. Tiers: ${rateLimitTiers().join(', ')}`,
          },
          400,
        );
      }

      // One write either way: an upsert for tenant keys (which may not exist
      // yet), a plain update for the seeded tier and api-key rows.
      if (isTenantKey && (body.window_ms === undefined || body.max_requests === undefined)) {
        const exists = await db
          .selectFrom('zv_rate_limit_configs')
          .select('key_prefix')
          .where('key_prefix', '=', keyPrefix)
          .executeTakeFirst();
        if (!exists) {
          return c.json(
            { error: 'window_ms and max_requests are required to create a tenant limit' },
            400,
          );
        }
      }

      // The change and its audit row commit together: an unaudited limit
      // change is exactly what an operator reviewing an incident must not find.
      const row = await db.transaction().execute(async (trx) => {
        const written = isTenantKey
          ? await trx
              .insertInto('zv_rate_limit_configs')
              .values({ key_prefix: keyPrefix, ...updates })
              .onConflict((oc) => oc.column('key_prefix').doUpdateSet(updates))
              .returningAll()
              .executeTakeFirst()
          : await trx
              .updateTable('zv_rate_limit_configs')
              .set(updates)
              .where('key_prefix', '=', keyPrefix)
              .returningAll()
              .executeTakeFirst();
        if (!written) return undefined;
        await auditLog(trx, {
          type: 'settings.changed',
          userId: user.id,
          resourceId: keyPrefix,
          resourceType: 'rate_limit',
          metadata: body,
        });
        return written;
      });

      if (!row) return c.json({ error: 'Rate limit config not found' }, 404);
      invalidateRateLimitCache(keyPrefix);
      return c.json({ rate_limit: row });
    },
  );

  // POST /rate-limits/reset — restore all tiers to compiled defaults
  app.post('/rate-limits/reset', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    // The limiters' own compiled values. A second list here named six of the
    // thirteen tiers, so reset left the other seven wherever they had been set.
    const defaults = rateLimitDefaults();
    for (const d of defaults) {
      await db
        .insertInto('zv_rate_limit_configs')
        .values(d)
        .onConflict((oc) =>
          oc.column('key_prefix').doUpdateSet({
            window_ms: d.window_ms,
            max_requests: d.max_requests,
            updated_at: new Date(),
          }),
        )
        .execute();
    }
    invalidateRateLimitCache();
    await auditLog(db, {
      type: 'settings.changed',
      tenantId: null,
      userId: user?.id,
      resourceType: 'rate_limit_reset',
      metadata: { tiers: defaults.map((d) => d.key_prefix) },
    });
    return c.json({ success: true });
  });

  // ── Column-level Permissions ──────────────────────────────────

  const ColumnPermSchema = z.object({
    collection_name: z.string().min(1),
    column_name: z.string().min(1),
    role: z.string().min(1),
    can_read: z.boolean().default(true),
    can_write: z.boolean().default(true),
  });

  // GET /column-permissions?collection=xxx
  app.get('/column-permissions', async (c) => {
    const { collection } = c.req.query();
    let query = db
      .selectFrom('zvd_column_permissions')
      .selectAll()
      .orderBy('collection_name')
      .orderBy('column_name');
    if (collection) query = query.where('collection_name', '=', collection);
    const rows = await query.execute();
    return c.json({ column_permissions: rows });
  });

  // POST /column-permissions
  app.post('/column-permissions', zValidator('json', ColumnPermSchema), async (c) => {
    const data = c.req.valid('json');
    const row = await putColumnPermission(db, data);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.granted',
      tenantId: null,
      userId: user?.id,
      resourceId: row?.id,
      resourceType: 'column_permission',
      metadata: data,
    });
    return c.json({ column_permission: row }, 201);
  });

  // PUT /column-permissions/:id
  app.put('/column-permissions/:id', zValidator('json', ColumnPermSchema.partial()), async (c) => {
    const data = c.req.valid('json');
    const row = await db
      .updateTable('zvd_column_permissions')
      .set({ ...data, updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();
    if (!row) return c.json({ error: 'Not found' }, 404);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    await invalidateColumnPermCache((row as any).collection_name);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.granted',
      tenantId: null,
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'column_permission',
      metadata: data,
    });
    return c.json({ column_permission: row });
  });

  // DELETE /column-permissions/:id
  app.delete('/column-permissions/:id', async (c) => {
    await deleteColumnPermission(db, c.req.param('id'));
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.revoked',
      tenantId: null,
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'column_permission',
    });
    return c.json({ success: true });
  });

  // The SQL editor used to have a second implementation here, and this one
  // won: mounted at `/api/admin` on line 375 of routes/index.ts, it matched
  // POST /api/admin/sql before the dedicated mount on line 447 ever saw the
  // request. So routes/sql-editor.ts — the version with the stronger gate —
  // was unreachable, and the reachable one sat behind `requireAdmin`, which
  // `checkPermission(uid, "admin", "*")` grants to a delegated tenant owner
  // inside their own domain. That is precisely the escalation
  // `requireInstanceAdmin` was written to close; the fix had landed in the
  // file nobody called.
  //
  // Its safety was a blocklist over the query text — DROP DATABASE, DROP
  // SCHEMA, ALTER SYSTEM, COPY — which a comment, a lowercase keyword, or a
  // CTE walks straight through. See routes/sql-editor.ts for the one that
  // serves now: instance-admin only, READ ONLY unless the caller asks for
  // write, and Postgres enforcing the refusal rather than a regex.

  // GET /extensions/health — per-extension runtime status.
  //
  // Returns inline + worker extensions in a single list. Worker
  // extensions carry isolation bookkeeping (workerGeneration, crash /
  // hang timestamps, in-flight + total request counts, integrity).
  // Inline extensions return a minimal record because there's no
  // separate runtime to observe.
  //
  // NOTE: rssBytes is NOT included per-extension. Bun.Worker is a
  // thread, so per-thread RSS is not measurable from the OS layer.
  // engine_rss_mb at the response root is the total process RSS —
  // useful for capacity planning, NOT a per-extension breakdown.
  app.get('/extensions/health', async (c) => {
    const { getWorkerHostIfInitialized } = await import('../../lib/worker-extension-host.js');
    const { extensionLoader } = await import('../../lib/extensions/index.js');
    const host = getWorkerHostIfInitialized();
    const workers = host ? host.getHealth() : [];
    const inlineNames = extensionLoader
      .getActive()
      .filter((n) => !workers.some((w) => w.name === n));
    const inline = inlineNames.map((name) => ({
      name,
      isolation: 'inline' as const,
      status: 'running' as const,
      loadError: extensionLoader.getLastLoadError(name),
    }));
    const memoryUsage = process.memoryUsage();
    return c.json({
      engine_rss_mb: Math.round(memoryUsage.rss / 1024 / 1024),
      engine_heap_used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      extensions: [...inline, ...workers],
    });
  });
}
