/**
 * Insights — Analytics Dashboards + Panels (Enterprise)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission } from '../lib/permissions.js';

export function insightsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware — all routes require a session
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // ── GET /stats ───────────────────────────────────────────────────────────────
  app.get('/stats', async (c) => {
    const user = c.get('user') as any;
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

    const [dashRow, panelRow, topPanels, avgRow] = await Promise.all([
      sql<{ count: string }>`SELECT COUNT(*) AS count FROM zv_dashboards`.execute(db),
      sql<{ count: string }>`SELECT COUNT(*) AS count FROM zv_panels`.execute(db),
      sql<{ id: string; title: string; avg_execution_ms: number | null }>`
        SELECT id, title, avg_execution_ms
        FROM zv_panels
        WHERE last_executed_at IS NOT NULL
        ORDER BY avg_execution_ms DESC NULLS LAST
        LIMIT 5
      `.execute(db),
      sql<{ avg: string | null }>`
        SELECT AVG(avg_execution_ms) AS avg FROM zv_panels WHERE avg_execution_ms IS NOT NULL
      `.execute(db),
    ]);

    return c.json({
      total_dashboards: Number(dashRow.rows[0]?.count ?? 0),
      total_panels: Number(panelRow.rows[0]?.count ?? 0),
      most_used_panels: topPanels.rows,
      avg_execution_ms: avgRow.rows[0]?.avg ? Number(avgRow.rows[0].avg).toFixed(1) : null,
    });
  });

  // ── GET /dashboards ──────────────────────────────────────────────────────────
  app.get('/dashboards', async (c) => {
    const user = c.get('user') as any;

    // Show public dashboards + own dashboards + dashboards shared with the user
    const result = await sql<any>`
      SELECT DISTINCT d.*, COUNT(p.id) AS panel_count
      FROM zv_dashboards d
      LEFT JOIN zv_panels p ON p.dashboard_id = d.id
      LEFT JOIN zvd_dashboard_shares s ON s.dashboard_id = d.id
      WHERE d.is_public = true
         OR d.created_by = ${user.id}
         OR s.shared_with_user_id = ${user.id}
      GROUP BY d.id
      ORDER BY d.updated_at DESC
    `.execute(db);

    return c.json({ dashboards: result.rows });
  });

  // ── POST /dashboards ─────────────────────────────────────────────────────────
  app.post(
    '/dashboards',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        layout: z.array(z.unknown()).optional().default([]),
        is_public: z.boolean().optional().default(false),
        tags: z.array(z.string()).optional().default([]),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const body = c.req.valid('json');

      const dashboard = await (db as any)
        .insertInto('zv_dashboards')
        .values({
          name: body.name,
          description: body.description ?? null,
          layout: JSON.stringify(body.layout),
          is_public: body.is_public,
          tags: body.tags,
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ dashboard }, 201);
    },
  );

  // ── GET /dashboards/:id ──────────────────────────────────────────────────────
  app.get('/dashboards/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');

    const dash = await (db as any)
      .selectFrom('zv_dashboards')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!dash) return c.json({ error: 'Not found' }, 404);

    // Access check: public, owner, or shared
    if (!dash.is_public && dash.created_by !== user.id) {
      const share = await (db as any)
        .selectFrom('zvd_dashboard_shares')
        .select(['id'])
        .where('dashboard_id', '=', id)
        .where('shared_with_user_id', '=', user.id)
        .executeTakeFirst();
      if (!share) {
        const isAdmin = await checkPermission(user.id, 'admin', '*');
        if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
      }
    }

    const panels = await (db as any)
      .selectFrom('zv_panels')
      .selectAll()
      .where('dashboard_id', '=', id)
      .orderBy('position', 'asc')
      .execute();

    // Update last_viewed_at + view_count
    await (db as any)
      .updateTable('zv_dashboards')
      .set({
        last_viewed_at: new Date(),
        view_count: sql`view_count + 1`,
      })
      .where('id', '=', id)
      .execute()
      .catch(() => { /* non-fatal */ });

    return c.json({ dashboard: dash, panels });
  });

  // ── DELETE /dashboards/:id ───────────────────────────────────────────────────
  app.delete('/dashboards/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');

    const dash = await (db as any)
      .selectFrom('zv_dashboards')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!dash) return c.json({ error: 'Not found' }, 404);

    if (dash.created_by !== user.id) {
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
    }

    await (db as any).deleteFrom('zv_dashboards').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // ── GET /dashboards/:id/shares ───────────────────────────────────────────────
  app.get('/dashboards/:id/shares', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');

    const dash = await (db as any)
      .selectFrom('zv_dashboards')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!dash) return c.json({ error: 'Not found' }, 404);

    if (dash.created_by !== user.id) {
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
    }

    const shares = await (db as any)
      .selectFrom('zvd_dashboard_shares')
      .selectAll()
      .where('dashboard_id', '=', id)
      .execute();

    return c.json({ shares });
  });

  // ── POST /dashboards/:id/shares ──────────────────────────────────────────────
  app.post(
    '/dashboards/:id/shares',
    zValidator(
      'json',
      z.object({
        shared_with_user_id: z.string().optional(),
        shared_with_role: z.string().optional(),
        permission: z.enum(['view', 'edit']).default('view'),
      }).refine((d) => d.shared_with_user_id || d.shared_with_role, {
        message: 'Either shared_with_user_id or shared_with_role is required',
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const id = c.req.param('id');
      const body = c.req.valid('json');

      const dash = await (db as any)
        .selectFrom('zv_dashboards')
        .select(['id', 'created_by'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!dash) return c.json({ error: 'Not found' }, 404);

      if (dash.created_by !== user.id) {
        const isAdmin = await checkPermission(user.id, 'admin', '*');
        if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
      }

      const share = await (db as any)
        .insertInto('zvd_dashboard_shares')
        .values({
          dashboard_id: id,
          shared_with_user_id: body.shared_with_user_id ?? null,
          shared_with_role: body.shared_with_role ?? null,
          permission: body.permission,
          created_by: user.id,
        })
        .onConflict((oc: any) => oc.doUpdateSet({ permission: body.permission }))
        .returningAll()
        .executeTakeFirst();

      return c.json({ share }, 201);
    },
  );

  // ── DELETE /dashboards/:id/shares/:shareId ───────────────────────────────────
  app.delete('/dashboards/:id/shares/:shareId', async (c) => {
    const user = c.get('user') as any;
    const { id, shareId } = c.req.param();

    const dash = await (db as any)
      .selectFrom('zv_dashboards')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!dash) return c.json({ error: 'Dashboard not found' }, 404);

    if (dash.created_by !== user.id) {
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
    }

    const deleted = await (db as any)
      .deleteFrom('zvd_dashboard_shares')
      .where('id', '=', shareId)
      .where('dashboard_id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!deleted) return c.json({ error: 'Share not found' }, 404);
    return c.json({ success: true });
  });

  // ── POST /dashboards/:id/panels ──────────────────────────────────────────────
  app.post(
    '/dashboards/:id/panels',
    zValidator(
      'json',
      z.object({
        title: z.string().min(1).max(200),
        type: z.enum(['table', 'bar', 'line', 'pie', 'metric', 'area']).default('table'),
        query: z.string().min(1),
        config: z.record(z.string(), z.unknown()).optional().default({}),
        position: z.record(z.string(), z.unknown()).optional().default({}),
        refresh_interval: z.number().int().positive().optional(),
      }),
    ),
    async (c) => {
      const dashboardId = c.req.param('id');
      const body = c.req.valid('json');

      const dash = await (db as any)
        .selectFrom('zv_dashboards')
        .select(['id'])
        .where('id', '=', dashboardId)
        .executeTakeFirst();

      if (!dash) return c.json({ error: 'Dashboard not found' }, 404);

      const panel = await (db as any)
        .insertInto('zv_panels')
        .values({
          dashboard_id: dashboardId,
          title: body.title,
          type: body.type,
          query: body.query,
          config: JSON.stringify(body.config),
          position: JSON.stringify(body.position),
          refresh_interval: body.refresh_interval ?? null,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ panel }, 201);
    },
  );

  // ── PATCH /panels/:id ────────────────────────────────────────────────────────
  app.patch(
    '/panels/:id',
    zValidator(
      'json',
      z.object({
        title: z.string().min(1).max(200).optional(),
        type: z.enum(['table', 'bar', 'line', 'pie', 'metric', 'area']).optional(),
        query: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        position: z.record(z.string(), z.unknown()).optional(),
        refresh_interval: z.number().int().positive().nullable().optional(),
      }),
    ),
    async (c) => {
      const id = c.req.param('id');
      const body = c.req.valid('json');

      const updates: Record<string, any> = { updated_at: new Date() };
      if (body.title !== undefined) updates.title = body.title;
      if (body.type !== undefined) updates.type = body.type;
      if (body.query !== undefined) updates.query = body.query;
      if (body.config !== undefined) updates.config = JSON.stringify(body.config);
      if (body.position !== undefined) updates.position = JSON.stringify(body.position);
      if (body.refresh_interval !== undefined) updates.refresh_interval = body.refresh_interval;

      const panel = await (db as any)
        .updateTable('zv_panels')
        .set(updates)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      if (!panel) return c.json({ error: 'Panel not found' }, 404);
      return c.json({ panel });
    },
  );

  // ── DELETE /panels/:id ───────────────────────────────────────────────────────
  app.delete('/panels/:id', async (c) => {
    const deleted = await (db as any)
      .deleteFrom('zv_panels')
      .where('id', '=', c.req.param('id'))
      .returningAll()
      .executeTakeFirst();

    if (!deleted) return c.json({ error: 'Panel not found' }, 404);
    return c.json({ success: true });
  });

  // ── POST /panels/:id/execute ─────────────────────────────────────────────────
  app.post('/panels/:id/execute', async (c) => {
    const id = c.req.param('id');

    const panel = await (db as any)
      .selectFrom('zv_panels')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!panel) return c.json({ error: 'Panel not found' }, 404);

    // Check cache first
    const cached = await (db as any)
      .selectFrom('zvd_panel_cache')
      .selectAll()
      .where('panel_id', '=', id)
      .executeTakeFirst();

    if (cached && new Date(cached.expires_at) > new Date()) {
      return c.json({
        data: cached.result,
        type: panel.type,
        row_count: cached.row_count,
        cached: true,
        executed_at: cached.executed_at,
        execution_ms: cached.execution_ms,
      });
    }

    const panelQuery = panel.query?.trim();
    if (!panelQuery) return c.json({ error: 'Panel has no query configured' }, 400);

    const normalized = panelQuery.toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return c.json({ error: 'Only SELECT queries are allowed in panels' }, 400);
    }

    const start = Date.now();
    try {
      const result = (await Promise.race([
        sql.raw(panelQuery).execute(db),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout')), 10000),
        ),
      ])) as any;

      const executionMs = Date.now() - start;
      const rows = result.rows ?? [];

      // Update/insert cache
      await (db as any)
        .insertInto('zvd_panel_cache')
        .values({
          panel_id: id,
          result: JSON.stringify(rows),
          row_count: rows.length,
          executed_at: new Date(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000),
          execution_ms: executionMs,
        })
        .onConflict((oc: any) =>
          oc.column('panel_id').doUpdateSet({
            result: JSON.stringify(rows),
            row_count: rows.length,
            executed_at: new Date(),
            expires_at: new Date(Date.now() + 5 * 60 * 1000),
            execution_ms: executionMs,
          }),
        )
        .execute()
        .catch(() => { /* non-fatal */ });

      // Update panel metadata
      const currentAvg = panel.avg_execution_ms ?? executionMs;
      const newAvg = Math.round((currentAvg + executionMs) / 2);
      await (db as any)
        .updateTable('zv_panels')
        .set({
          last_executed_at: new Date(),
          avg_execution_ms: newAvg,
        })
        .where('id', '=', id)
        .execute()
        .catch(() => { /* non-fatal */ });

      return c.json({ data: rows, type: panel.type, row_count: rows.length, cached: false, execution_ms: executionMs });
    } catch (err: any) {
      // Increment error count
      await (db as any)
        .updateTable('zv_panels')
        .set({ error_count: sql`error_count + 1` })
        .where('id', '=', id)
        .execute()
        .catch(() => { /* non-fatal */ });

      return c.json({ error: String(err) }, 400);
    }
  });

  // ── POST /query — admin ad-hoc SELECT ────────────────────────────────────────
  app.post(
    '/query',
    zValidator(
      'json',
      z.object({
        query: z.string().min(1),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

      const { query } = c.req.valid('json');
      const normalized = query.trim().toUpperCase();
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
        return c.json({ error: 'Only SELECT queries are allowed' }, 400);
      }

      try {
        const result = (await Promise.race([
          sql.raw(query).execute(db),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Query timeout')), 10000),
          ),
        ])) as any;
        return c.json({
          data: result.rows,
          columns: Object.keys(result.rows[0] || {}),
        });
      } catch (err) {
        return c.json({ error: String(err) }, 400);
      }
    },
  );

  // ── GET /saved-queries ───────────────────────────────────────────────────────
  app.get('/saved-queries', async (c) => {
    const user = c.get('user') as any;

    const queries = await (db as any)
      .selectFrom('zvd_insight_saved_queries')
      .selectAll()
      .where((eb: any) =>
        eb.or([eb('is_public', '=', true), eb('created_by', '=', user.id)]),
      )
      .orderBy('use_count', 'desc')
      .orderBy('created_at', 'desc')
      .execute();

    return c.json({ queries });
  });

  // ── POST /saved-queries ──────────────────────────────────────────────────────
  app.post(
    '/saved-queries',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        query: z.string().min(1),
        tags: z.array(z.string()).optional().default([]),
        is_public: z.boolean().optional().default(false),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const body = c.req.valid('json');

      const savedQuery = await (db as any)
        .insertInto('zvd_insight_saved_queries')
        .values({
          name: body.name,
          description: body.description ?? null,
          query: body.query,
          tags: body.tags,
          is_public: body.is_public,
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ query: savedQuery }, 201);
    },
  );

  // ── PATCH /saved-queries/:id ─────────────────────────────────────────────────
  app.patch(
    '/saved-queries/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().nullable().optional(),
        query: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        is_public: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const id = c.req.param('id');
      const body = c.req.valid('json');

      const existing = await (db as any)
        .selectFrom('zvd_insight_saved_queries')
        .select(['id', 'created_by'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) return c.json({ error: 'Saved query not found' }, 404);

      if (existing.created_by !== user.id) {
        const isAdmin = await checkPermission(user.id, 'admin', '*');
        if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
      }

      const updates: Record<string, any> = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.query !== undefined) updates.query = body.query;
      if (body.tags !== undefined) updates.tags = body.tags;
      if (body.is_public !== undefined) updates.is_public = body.is_public;

      const savedQuery = await (db as any)
        .updateTable('zvd_insight_saved_queries')
        .set(updates)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();

      return c.json({ query: savedQuery });
    },
  );

  // ── DELETE /saved-queries/:id ────────────────────────────────────────────────
  app.delete('/saved-queries/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');

    const existing = await (db as any)
      .selectFrom('zvd_insight_saved_queries')
      .select(['id', 'created_by'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (!existing) return c.json({ error: 'Saved query not found' }, 404);

    if (existing.created_by !== user.id) {
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin) return c.json({ error: 'Forbidden' }, 403);
    }

    await (db as any).deleteFrom('zvd_insight_saved_queries').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // ── POST /saved-queries/:id/execute ─────────────────────────────────────────
  app.post('/saved-queries/:id/execute', async (c) => {
    const id = c.req.param('id');

    const savedQuery = await (db as any)
      .selectFrom('zvd_insight_saved_queries')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!savedQuery) return c.json({ error: 'Saved query not found' }, 404);

    const queryText = savedQuery.query?.trim();
    const normalized = queryText.toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return c.json({ error: 'Only SELECT queries are allowed' }, 400);
    }

    try {
      const result = (await Promise.race([
        sql.raw(queryText).execute(db),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout')), 10000),
        ),
      ])) as any;

      // Increment use_count
      await (db as any)
        .updateTable('zvd_insight_saved_queries')
        .set({ use_count: sql`use_count + 1` })
        .where('id', '=', id)
        .execute()
        .catch(() => { /* non-fatal */ });

      return c.json({ data: result.rows, columns: Object.keys(result.rows[0] || {}) });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // ── GET /subscriptions ───────────────────────────────────────────────────────
  app.get('/subscriptions', async (c) => {
    const user = c.get('user') as any;

    const subscriptions = await (db as any)
      .selectFrom('zvd_dashboard_subscriptions')
      .selectAll()
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .execute();

    return c.json({ subscriptions });
  });

  // ── POST /subscriptions ──────────────────────────────────────────────────────
  app.post(
    '/subscriptions',
    zValidator(
      'json',
      z.object({
        dashboard_id: z.string().uuid(),
        email: z.string().email(),
        frequency: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
        day_of_week: z.number().int().min(0).max(6).optional(),
        hour_of_day: z.number().int().min(0).max(23).default(8),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const body = c.req.valid('json');

      const dash = await (db as any)
        .selectFrom('zv_dashboards')
        .select(['id'])
        .where('id', '=', body.dashboard_id)
        .executeTakeFirst();

      if (!dash) return c.json({ error: 'Dashboard not found' }, 404);

      const subscription = await (db as any)
        .insertInto('zvd_dashboard_subscriptions')
        .values({
          dashboard_id: body.dashboard_id,
          user_id: user.id,
          email: body.email,
          frequency: body.frequency,
          day_of_week: body.day_of_week ?? null,
          hour_of_day: body.hour_of_day,
          is_active: true,
        })
        .onConflict((oc: any) =>
          oc.columns(['dashboard_id', 'user_id']).doUpdateSet({
            email: body.email,
            frequency: body.frequency,
            day_of_week: body.day_of_week ?? null,
            hour_of_day: body.hour_of_day,
            is_active: true,
          }),
        )
        .returningAll()
        .executeTakeFirst();

      return c.json({ subscription }, 201);
    },
  );

  // ── DELETE /subscriptions/:id ────────────────────────────────────────────────
  app.delete('/subscriptions/:id', async (c) => {
    const user = c.get('user') as any;
    const id = c.req.param('id');

    const deleted = await (db as any)
      .deleteFrom('zvd_dashboard_subscriptions')
      .where('id', '=', id)
      .where('user_id', '=', user.id)
      .returningAll()
      .executeTakeFirst();

    if (!deleted) return c.json({ error: 'Subscription not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}
