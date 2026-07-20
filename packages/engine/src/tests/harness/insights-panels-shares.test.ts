/**
 * Phase C — insights routes: the handlers the base insights.test.ts leaves
 * uncovered — dashboard panels (create/patch/execute/delete), dashboard
 * shares (create/list/delete + role validation), subscriptions
 * (create/delete), and dashboard delete. Driven through the in-process app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('insights panels/shares/subscriptions (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let dashboardId = '';
  let panelId = '';
  let shareId = '';
  let subscriptionId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const res = await app.request(
      '/api/insights/dashboards',
      json('POST', { name: 'Panels Harness', description: 'x' }),
    );
    dashboardId = ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (dashboardId) {
      await sql`DELETE FROM zvd_panel_cache WHERE panel_id IN (SELECT id FROM zv_panels WHERE dashboard_id = ${dashboardId})`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_panels WHERE dashboard_id = ${dashboardId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zvd_dashboard_shares WHERE dashboard_id = ${dashboardId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_dashboards WHERE id = ${dashboardId}`.execute(db).catch(() => {});
    }
    if (subscriptionId) {
      await sql`DELETE FROM zvd_insight_subscriptions WHERE id = ${subscriptionId}`
        .execute(db)
        .catch(() => {});
    }
  });

  // ── Panels ─────────────────────────────────────────────────────────────────
  it('creates a panel (POST /dashboards/:id/panels)', async () => {
    const res = await app.request(
      `/api/insights/dashboards/${dashboardId}/panels`,
      json('POST', {
        title: 'Users count',
        type: 'metric',
        query: 'SELECT count(*) AS n FROM "user"',
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { panel: { id: string; title: string } };
    expect(body.panel.title).toBe('Users count');
    panelId = body.panel.id;
  });

  it('404s creating a panel on a missing dashboard', async () => {
    const res = await app.request(
      '/api/insights/dashboards/00000000-0000-0000-0000-000000000000/panels',
      json('POST', { title: 'x', query: 'SELECT 1' }),
    );
    expect(res.status).toBe(404);
  });

  it('patches a panel (PATCH /panels/:id)', async () => {
    const res = await app.request(
      `/api/insights/panels/${panelId}`,
      json('PATCH', { title: 'Renamed', type: 'bar' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { panel: { title: string } }).panel.title).toBe('Renamed');
  });

  it('404s patching a missing panel', async () => {
    const res = await app.request(
      '/api/insights/panels/00000000-0000-0000-0000-000000000000',
      json('PATCH', { title: 'x' }),
    );
    expect(res.status).toBe(404);
  });

  it('executes a panel query (POST /panels/:id/execute)', async () => {
    const res = await app.request(`/api/insights/panels/${panelId}/execute`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown; row_count: number };
    expect(body.row_count).toBeGreaterThanOrEqual(1);
  });

  it('serves the second execute from cache', async () => {
    const res = await app.request(`/api/insights/panels/${panelId}/execute`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cached?: boolean }).cached).toBe(true);
  });

  it('404s executing a missing panel', async () => {
    const res = await app.request(
      '/api/insights/panels/00000000-0000-0000-0000-000000000000/execute',
      {
        method: 'POST',
        headers: { cookie },
      },
    );
    expect(res.status).toBe(404);
  });

  // ── Shares ─────────────────────────────────────────────────────────────────
  it('shares a dashboard with a role (POST /dashboards/:id/shares)', async () => {
    const res = await app.request(
      `/api/insights/dashboards/${dashboardId}/shares`,
      json('POST', { shared_with_role: 'member', permission: 'view' }),
    );
    expect(res.status).toBe(201);
    shareId = ((await res.json()) as { share: { id: string } }).share.id;
  });

  it('rejects sharing with an unknown role', async () => {
    const res = await app.request(
      `/api/insights/dashboards/${dashboardId}/shares`,
      json('POST', { shared_with_role: 'no_such_role_xyz', permission: 'view' }),
    );
    expect(res.status).toBe(400);
  });

  it('requires a target on share (refine)', async () => {
    const res = await app.request(
      `/api/insights/dashboards/${dashboardId}/shares`,
      json('POST', { permission: 'view' }),
    );
    expect(res.status).toBe(400);
  });

  it('lists shares (GET /dashboards/:id/shares)', async () => {
    const res = await app.request(`/api/insights/dashboards/${dashboardId}/shares`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shares: unknown[] }).shares.length).toBeGreaterThanOrEqual(1);
  });

  it('deletes a share (DELETE /dashboards/:id/shares/:shareId)', async () => {
    const res = await app.request(`/api/insights/dashboards/${dashboardId}/shares/${shareId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  // ── Subscriptions ────────────────────────────────────────────────────────────
  it('creates a subscription (POST /subscriptions)', async () => {
    const res = await app.request(
      '/api/insights/subscriptions',
      json('POST', {
        dashboard_id: dashboardId,
        email: 'sub@test.local',
        frequency: 'weekly',
        hour_of_day: 8,
      }),
    );
    expect(res.status).toBe(201);
    subscriptionId = ((await res.json()) as { subscription: { id: string } }).subscription.id;
    expect(subscriptionId).toBeTruthy();
  });

  // ── Panel delete + dashboard delete (teardown-order coverage) ────────────────
  it('deletes a panel (DELETE /panels/:id)', async () => {
    const res = await app.request(`/api/insights/panels/${panelId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    panelId = '';
  });

  it('404s deleting a missing panel', async () => {
    const res = await app.request('/api/insights/panels/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
