/**
 * Phase C — /api/views (routes/zones.ts viewsRoutes).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hview_${Date.now()}`;

d('views routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let viewId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    if (viewId) {
      await db
        .deleteFrom('zvd_views')
        .where('id', '=', viewId)
        .execute()
        .catch(() => {});
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('GET /api/views lists view definitions', async () => {
    const res = await app.request('/api/views', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: unknown[]; total: number };
    expect(Array.isArray(body.views)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('POST /api/views creates a table view', async () => {
    const res = await app.request('/api/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness View ${Date.now()}`,
        collection: COLLECTION,
        view_type: 'table',
        fields: [{ name: 'title' }],
        page_size: 25,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { view: { id: string; collection: string } };
    viewId = body.view.id;
    expect(body.view.collection).toBe(COLLECTION);
  });

  it('GET /api/views/:id returns view detail', async () => {
    const res = await app.request(`/api/views/${viewId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { view: { id: string } };
    expect(body.view.id).toBe(viewId);
  });

  it('DELETE /api/views/:id removes the view', async () => {
    const res = await app.request(`/api/views/${viewId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    viewId = '';
  });
});
