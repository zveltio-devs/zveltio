/**
 * Insights — Analytics Dashboards + Panels
 *
 * GET    /api/insights/dashboards          — list dashboards
 * POST   /api/insights/dashboards          — create dashboard
 * GET    /api/insights/dashboards/:id      — get dashboard + panels
 * DELETE /api/insights/dashboards/:id      — delete dashboard
 * POST   /api/insights/dashboards/:id/panels — add panel
 * DELETE /api/insights/panels/:id          — delete panel
 * POST   /api/insights/panels/:id/execute  — execute panel query
 * POST   /api/insights/query               — ad-hoc SELECT (admin only)
 */

import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';

export function insightsRoutes(db: Database, _auth: any): Hono {
  const app = new Hono<{ Variables: { user: any } }>();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // GET /dashboards
  app.get('/dashboards', async (c) => {
    const result = await sql<any>`
      SELECT d.*, u.name AS creator_name, COUNT(p.id) AS panel_count
      FROM zv_dashboards d
      LEFT JOIN "user" u ON u.id = d.created_by
      LEFT JOIN zv_panels p ON p.dashboard_id = d.id
      GROUP BY d.id, u.name
      ORDER BY d.is_default DESC, d.name
    `.execute(db);
    return c.json({ dashboards: result.rows });
  });

  // POST /dashboards
  app.post('/dashboards', async (c) => {
    const user = c.get('user');
    const data = await c.req.json();
    const result = await sql<{ id: string }>`
      INSERT INTO zv_dashboards (name, description, icon, created_by)
      VALUES (${data.name}, ${data.description || null}, ${data.icon || 'BarChart'}, ${user.id})
      RETURNING id
    `.execute(db);
    return c.json({ id: result.rows[0].id }, 201);
  });

  // GET /dashboards/:id
  app.get('/dashboards/:id', async (c) => {
    const id = c.req.param('id');
    const dash = await sql<any>`SELECT * FROM zv_dashboards WHERE id = ${id}`.execute(db);
    if (dash.rows.length === 0) return c.json({ error: 'Not found' }, 404);
    const panels = await sql<any>`
      SELECT * FROM zv_panels WHERE dashboard_id = ${id} ORDER BY position_y, position_x
    `.execute(db);
    return c.json({ dashboard: dash.rows[0], panels: panels.rows });
  });

  // DELETE /dashboards/:id
  app.delete('/dashboards/:id', async (c) => {
    const id = c.req.param('id');
    await (db as any).deleteFrom('zv_dashboards').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // POST /dashboards/:id/panels
  app.post('/dashboards/:id/panels', async (c) => {
    const dashboardId = c.req.param('id');
    const data = await c.req.json();
    const result = await sql<{ id: string }>`
      INSERT INTO zv_panels (dashboard_id, name, type, query, config, position_x, position_y, width, height)
      VALUES (
        ${dashboardId}, ${data.name}, ${data.type || 'table'}, ${data.query || ''},
        ${JSON.stringify(data.config || {})}::jsonb,
        ${data.position_x ?? 0}, ${data.position_y ?? 0},
        ${data.width ?? 6}, ${data.height ?? 4}
      )
      RETURNING id
    `.execute(db);
    return c.json({ id: result.rows[0].id }, 201);
  });

  // PATCH /panels/:id — update panel
  app.patch('/panels/:id', async (c) => {
    const id = c.req.param('id');
    const data = await c.req.json();
    const panel = await (db as any)
      .updateTable('zv_panels')
      .set({ ...data, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!panel) return c.json({ error: 'Panel not found' }, 404);
    return c.json({ panel });
  });

  // DELETE /panels/:id
  app.delete('/panels/:id', async (c) => {
    const id = c.req.param('id');
    await (db as any).deleteFrom('zv_panels').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // POST /panels/:id/execute — execute panel query
  app.post('/panels/:id/execute', async (c) => {
    const id = c.req.param('id');
    try {
      const panel = await sql<{ query: string; type: string }>`
        SELECT query, type FROM zv_panels WHERE id = ${id}
      `.execute(db);
      if (panel.rows.length === 0) return c.json({ error: 'Panel not found' }, 404);

      const panelQuery = panel.rows[0].query.trim();
      if (!panelQuery) return c.json({ error: 'Panel has no query configured' }, 400);

      const normalized = panelQuery.toUpperCase();
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
        return c.json({ error: 'Only SELECT queries are allowed in panels' }, 400);
      }

      const result = await Promise.race([
        sql.raw(panelQuery).execute(db),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 10000)),
      ]) as any;

      return c.json({ data: result.rows, type: panel.rows[0].type });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // POST /query — ad-hoc SELECT (admin only)
  app.post('/query', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);

    const { query } = await c.req.json();
    if (!query) return c.json({ error: 'query required' }, 400);

    const normalized = query.trim().toUpperCase();
    if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
      return c.json({ error: 'Only SELECT queries are allowed' }, 400);
    }

    try {
      const result = await Promise.race([
        sql.raw(query).execute(db),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Query timeout')), 10000)),
      ]) as any;
      return c.json({ data: result.rows, columns: Object.keys(result.rows[0] || {}) });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  return app;
}
