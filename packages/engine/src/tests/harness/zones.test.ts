/**
 * Phase C — /api/zones portal layer (routes/zones.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SLUG = `hzone-${Date.now()}`;

d('zones routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let zoneId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (zoneId) {
      await db
        .deleteFrom('zvd_pages')
        .where('zone_id', '=', zoneId)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zvd_zones')
        .where('id', '=', zoneId)
        .execute()
        .catch(() => {});
    } else {
      await db
        .deleteFrom('zvd_zones')
        .where('slug', '=', SLUG)
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/zones lists zones for admins', async () => {
    const res = await app.request('/api/zones', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zones: unknown[] };
    expect(Array.isArray(body.zones)).toBe(true);
  });

  it('POST /api/zones creates a portal zone', async () => {
    const res = await app.request('/api/zones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'Harness Zone',
        slug: SLUG,
        description: 'portal test',
        is_active: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { zone: { slug: string; id: string } };
    zoneId = body.zone.id;
    expect(body.zone.slug).toBe(SLUG);
  });

  it('POST /api/zones/:slug/pages adds a page to the zone', async () => {
    const res = await app.request(`/api/zones/${SLUG}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Home',
        slug: 'home',
        is_homepage: true,
      }),
    });
    expect([200, 201]).toContain(res.status);
  });

  it('GET /api/zones/:slug/render returns public nav for the zone', async () => {
    const res = await app.request(`/api/zones/${SLUG}/render`, { headers: { cookie } });
    expect([200, 403]).toContain(res.status);
  });
});
