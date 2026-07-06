import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { checkPermission, getEnforcer } from '../../lib/permissions.js';
import { invalidateColumnPermCache } from '../../lib/column-permissions.js';
import { fieldTypeRegistry } from '../../lib/data/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getCache } from '../../lib/runtime/index.js';
import { auditLog } from '../../lib/audit.js';
import type { RequestUser } from '../data.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';

/**
 * Admin config routes (rate-limit configs, column-level permissions, SQL editor,
 * extensions health). Extracted from admin.ts (H-07 split). Route paths are
 * byte-identical.
 */
export function registerConfigRoutes(app: Hono, db: Database): void {
  // ── Rate Limit Configs ────────────────────────────────────────────────────

  // GET /rate-limits — list all configurable tiers
  app.get('/rate-limits', async (c) => {
    const rows = await db
      .selectFrom('zv_rate_limit_configs')
      .selectAll()
      .orderBy('key_prefix')
      .execute();
    return c.json({ rate_limits: rows });
  });

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
      const { keyPrefix } = c.req.param() as { keyPrefix: string };
      const body = c.req.valid('json');

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const updates: any = { updated_at: new Date(), updated_by: user.id };
      if (body.window_ms !== undefined) updates.window_ms = body.window_ms;
      if (body.max_requests !== undefined) updates.max_requests = body.max_requests;
      if (body.is_active !== undefined) updates.is_active = body.is_active;
      if (body.description !== undefined) updates.description = body.description;

      const row = await db
        .updateTable('zv_rate_limit_configs')
        .set(updates)
        .where('key_prefix', '=', keyPrefix)
        .returningAll()
        .executeTakeFirst();

      if (!row) return c.json({ error: 'Rate limit config not found' }, 404);
      invalidateRateLimitCache(keyPrefix);
      await auditLog(db, {
        type: 'settings.changed',
        userId: user.id,
        resourceId: keyPrefix,
        resourceType: 'rate_limit',
        metadata: body,
      });
      return c.json({ rate_limit: row });
    },
  );

  // POST /rate-limits/reset — restore all tiers to compiled defaults
  app.post('/rate-limits/reset', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    const defaults = [
      { key_prefix: 'auth', window_ms: 60000, max_requests: 10 },
      { key_prefix: 'api', window_ms: 60000, max_requests: 200 },
      { key_prefix: 'ai', window_ms: 60000, max_requests: 20 },
      { key_prefix: 'write', window_ms: 60000, max_requests: 60 },
      { key_prefix: 'ddl', window_ms: 60000, max_requests: 10 },
      { key_prefix: 'destructive', window_ms: 60000, max_requests: 10 },
    ];
    for (const d of defaults) {
      await db
        .updateTable('zv_rate_limit_configs')
        .set({ window_ms: d.window_ms, max_requests: d.max_requests, updated_at: new Date() })
        .where('key_prefix', '=', d.key_prefix)
        .execute();
    }
    invalidateRateLimitCache();
    await auditLog(db, {
      type: 'settings.changed',
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
    const row = await db
      .insertInto('zvd_column_permissions')
      .values(data)
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .onConflict((oc: any) =>
        oc.columns(['collection_name', 'column_name', 'role']).doUpdateSet({
          can_read: data.can_read,
          can_write: data.can_write,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();
    await invalidateColumnPermCache(data.collection_name);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.granted',
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    await invalidateColumnPermCache((row as any).collection_name);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.granted',
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'column_permission',
      metadata: data,
    });
    return c.json({ column_permission: row });
  });

  // DELETE /column-permissions/:id
  app.delete('/column-permissions/:id', async (c) => {
    const deleted = await db
      .deleteFrom('zvd_column_permissions')
      .where('id', '=', c.req.param('id'))
      .returning('collection_name')
      .executeTakeFirst();
    if (deleted?.collection_name) await invalidateColumnPermCache(deleted.collection_name);
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const user = c.get('user' as never) as any;
    await auditLog(db, {
      type: 'permission.revoked',
      userId: user?.id,
      resourceId: c.req.param('id'),
      resourceType: 'column_permission',
    });
    return c.json({ success: true });
  });

  // ── SQL Editor (admin-only, safe read/write with timeout) ─────

  app.post(
    '/sql',
    zValidator(
      'json',
      z.object({
        query: z.string().min(1).max(50_000),
        timeout_ms: z.number().int().min(100).max(30_000).optional(),
      }),
    ),
    async (c) => {
      const { query, timeout_ms: _timeout_ms = 10_000 } = c.req.valid('json');
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      const user = c.get('user' as never) as any;

      // Reject obviously dangerous patterns
      const normalized = query.trim().toUpperCase();
      const BLOCKED = ['DROP DATABASE', 'DROP SCHEMA', 'ALTER SYSTEM', 'COPY TO', 'COPY FROM'];
      for (const pat of BLOCKED) {
        if (normalized.includes(pat)) {
          await auditLog(db, {
            type: 'sql.failed',
            userId: user?.id,
            resourceType: 'sql_editor',
            metadata: { blocked: pat, query: query.slice(0, 500) },
          });
          return c.json({ error: `Blocked statement: ${pat}` }, 400);
        }
      }

      try {
        // Wrap in a transaction so SET LOCAL statement_timeout applies on
        // the same connection that runs the user query — without this the
        // pool can route them to different sessions and the timeout is a
        // no-op. Caller-supplied timeout_ms is clamped by the zod schema.
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        const result = (await db.transaction().execute(async (trx: any) => {
          const seconds = Math.max(1, Math.ceil(_timeout_ms / 1000));
          await sql.raw(`SET LOCAL statement_timeout = '${seconds}s'`).execute(trx);
          return sql.raw(query).execute(trx);
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        })) as any;
        const rows = result.rows ?? [];
        await auditLog(db, {
          type: 'sql.executed',
          userId: user?.id,
          resourceType: 'sql_editor',
          metadata: { query: query.slice(0, 500), rowCount: rows.length },
        });
        return c.json({ rows, rowCount: rows.length });
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      } catch (err: any) {
        await auditLog(db, {
          type: 'sql.failed',
          userId: user?.id,
          resourceType: 'sql_editor',
          metadata: { query: query.slice(0, 500), error: err?.message ?? String(err) },
        });
        return c.json({ error: err.message ?? String(err) }, 400);
      }
    },
  );

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
