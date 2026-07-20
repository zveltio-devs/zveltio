/**
 * Phase C — zones routes: the zone → pages → page-views hierarchy and the
 * render endpoints that the base zones tests leave uncovered. Drives
 * routes/zones.ts through the in-process app with a god session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SLUG = `harness-zone-${Date.now()}`;

d('zones pages/views (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let viewId = '';
  let pageViewId = '';

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
    await sql`DELETE FROM zv_zones WHERE slug = ${SLUG}`.execute(db).catch(() => {});
    if (viewId) await sql`DELETE FROM zv_views WHERE id = ${viewId}`.execute(db).catch(() => {});
  });

  it('creates a saved view (POST /api/views)', async () => {
    const res = await app.request(
      '/api/views',
      json('POST', { name: 'Harness Users', collection: 'user', view_type: 'table' }),
    );
    expect(res.status).toBe(201);
    viewId = ((await res.json()) as { view: { id: string } }).view.id;
    expect(viewId).toBeTruthy();
  });

  it('lists and reads the view (GET /api/views, GET /api/views/:id)', async () => {
    const list = await app.request('/api/views', { headers: { cookie } });
    expect(list.status).toBe(200);
    const one = await app.request(`/api/views/${viewId}`, { headers: { cookie } });
    expect(one.status).toBe(200);
    expect(((await one.json()) as { view: { name: string } }).view.name).toBe('Harness Users');
  });

  it('updates the view (PUT /api/views/:id)', async () => {
    const res = await app.request(
      `/api/views/${viewId}`,
      json('PUT', { name: 'Harness Users v2' }),
    );
    expect(res.status).toBe(200);
  });

  it('creates a zone (POST /api/zones)', async () => {
    const res = await app.request('/api/zones', json('POST', { name: 'Harness Zone', slug: SLUG }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { zone: { slug: string } }).zone.slug).toBe(SLUG);
  });

  it('rejects a duplicate zone slug', async () => {
    const res = await app.request('/api/zones', json('POST', { name: 'Dup', slug: SLUG }));
    expect([400, 409]).toContain(res.status);
  });

  it('reads and updates the zone (GET/PUT /api/zones/:slug)', async () => {
    const get = await app.request(`/api/zones/${SLUG}`, { headers: { cookie } });
    expect(get.status).toBe(200);
    const put = await app.request(`/api/zones/${SLUG}`, json('PUT', { description: 'updated' }));
    expect(put.status).toBe(200);
  });

  it('404s reading an unknown zone', async () => {
    const res = await app.request('/api/zones/no-such-zone-xyz', { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('creates a page in the zone (POST /api/zones/:slug/pages)', async () => {
    const res = await app.request(
      `/api/zones/${SLUG}/pages`,
      json('POST', { title: 'Home', slug: 'home', is_homepage: true }),
    );
    expect(res.status).toBe(201);
  });

  it('lists pages (GET /api/zones/:slug/pages)', async () => {
    const res = await app.request(`/api/zones/${SLUG}/pages`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { pages: unknown[] }).pages.length).toBeGreaterThanOrEqual(1);
  });

  it('updates a page (PUT /api/zones/:slug/pages/:pageSlug)', async () => {
    const res = await app.request(
      `/api/zones/${SLUG}/pages/home`,
      json('PUT', { title: 'Homepage' }),
    );
    expect(res.status).toBe(200);
  });

  it('attaches a view to a page (POST /api/zones/:slug/pages/:pageSlug/views)', async () => {
    const res = await app.request(
      `/api/zones/${SLUG}/pages/home/views`,
      json('POST', { view_id: viewId, col_span: 6 }),
    );
    expect(res.status).toBe(201);
    pageViewId = ((await res.json()) as { page_view: { id: string } }).page_view.id;
    expect(pageViewId).toBeTruthy();
  });

  it('lists page views (GET /api/zones/:slug/pages/:pageSlug/views)', async () => {
    const res = await app.request(`/api/zones/${SLUG}/pages/home/views`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { views: unknown[] }).views.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the zone (GET /api/zones/:slug/render)', async () => {
    const res = await app.request(`/api/zones/${SLUG}/render`, { headers: { cookie } });
    expect([200, 404]).toContain(res.status);
  });

  it('deletes the page (DELETE /api/zones/:slug/pages/:pageSlug)', async () => {
    const res = await app.request(`/api/zones/${SLUG}/pages/home`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('deletes the zone (DELETE /api/zones/:slug)', async () => {
    const res = await app.request(`/api/zones/${SLUG}`, { method: 'DELETE', headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('deletes the view (DELETE /api/views/:id)', async () => {
    const res = await app.request(`/api/views/${viewId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    viewId = '';
  });

  it('rejects unauthenticated zone listing', async () => {
    const res = await app.request('/api/zones');
    expect(res.status).toBe(401);
  });
});
