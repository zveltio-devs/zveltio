/**
 * Phase C — insights / analytics routes driven through the in-process app.
 *
 * Exercises routes/insights.ts: dashboards CRUD, stats, saved-queries lifecycle,
 * SQL safety guards (rejectIfDangerous / runReadOnlySql), and auth gates.
 * God session required for stats + saved-query writes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('insights routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let dashboardId = '';
  let savedQueryId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (savedQueryId) {
      await sql`DELETE FROM zvd_insight_saved_queries WHERE id = ${savedQueryId}`
        .execute(db)
        .catch(() => {});
    }
    if (dashboardId) {
      await sql`DELETE FROM zv_panels WHERE dashboard_id = ${dashboardId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_dashboards WHERE id = ${dashboardId}`.execute(db).catch(() => {});
    }
  });

  it('rejects unauthenticated access to dashboards', async () => {
    const res = await app.request('/api/insights/dashboards');
    expect([401, 403]).toContain(res.status);
  });

  it('lists dashboards (GET /api/insights/dashboards)', async () => {
    const res = await app.request('/api/insights/dashboards', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboards: unknown[] };
    expect(Array.isArray(body.dashboards)).toBe(true);
  });

  it('creates a dashboard (POST /api/insights/dashboards)', async () => {
    const res = await app.request(
      '/api/insights/dashboards',
      json('POST', { name: `Harness Dash ${Date.now()}`, is_public: false }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { dashboard: { id: string } };
    dashboardId = body.dashboard.id;
    expect(dashboardId.length).toBeGreaterThan(0);
  });

  it('reads a dashboard by id (GET /api/insights/dashboards/:id)', async () => {
    const res = await app.request(`/api/insights/dashboards/${dashboardId}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dashboard: { id: string } };
    expect(body.dashboard.id).toBe(dashboardId);
  });

  it('returns admin stats (GET /api/insights/stats)', async () => {
    const res = await app.request('/api/insights/stats', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total_dashboards: number; total_panels: number };
    expect(typeof body.total_dashboards).toBe('number');
    expect(typeof body.total_panels).toBe('number');
  });

  it('saved-queries lifecycle: create → list → execute → delete', async () => {
    const create = await app.request(
      '/api/insights/saved-queries',
      json('POST', {
        name: 'Harness SELECT 1',
        query: 'SELECT 1 AS one',
        is_public: false,
      }),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { query: { id: string } };
    savedQueryId = created.query.id;

    const list = await app.request('/api/insights/saved-queries', { headers: { cookie } });
    expect(list.status).toBe(200);

    const run = await app.request(`/api/insights/saved-queries/${savedQueryId}/execute`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(run.status).toBe(200);
    const runBody = (await run.json()) as { data: unknown[] };
    expect(Array.isArray(runBody.data)).toBe(true);

    const del = await app.request(`/api/insights/saved-queries/${savedQueryId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(del.status).toBe(200);
    savedQueryId = '';
  });

  it('rejects dangerous SQL on saved-query execute', async () => {
    const create = await app.request(
      '/api/insights/saved-queries',
      json('POST', {
        name: 'bad sql',
        query: 'SELECT 1; DROP TABLE zv_dashboards',
      }),
    );
    expect(create.status).toBe(201);
    const { query } = (await create.json()) as { query: { id: string } };

    const run = await app.request(`/api/insights/saved-queries/${query.id}/execute`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(run.status).toBe(400);

    await sql`DELETE FROM zvd_insight_saved_queries WHERE id = ${query.id}`
      .execute(db)
      .catch(() => {});
  });

  it('lists subscriptions (GET /api/insights/subscriptions)', async () => {
    const res = await app.request('/api/insights/subscriptions', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscriptions: unknown[] };
    expect(Array.isArray(body.subscriptions)).toBe(true);
  });
});
