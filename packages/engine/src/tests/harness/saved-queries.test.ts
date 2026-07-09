/**
 * Phase C — saved queries (query builder) driven through the in-process app.
 *
 * Exercises routes/saved-queries.ts: ad-hoc execute + preview-url, then the
 * save → list → get → update → run → delete → 404 lifecycle, plus the auth
 * guard and the collection-not-found path. The query targets a real collection
 * provisioned via DDLManager, so executeQueryConfig + the filter/sort/column
 * SQL builders run in-coverage.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLLECTION = `hsq_${Date.now()}`;
const CONFIG = {
  filters: [],
  filter_mode: 'AND',
  filter_groups: [],
  columns: ['title'],
  sorts: [{ field: 'title', direction: 'asc' }],
  limit: 20,
  page: 1,
};

d('saved queries (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let queryId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db) {
      await sql`DELETE FROM zv_saved_queries WHERE collection = ${COLLECTION}`
        .execute(db)
        .catch(() => {});
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  it('rejects unauthenticated access', async () => {
    const res = await app.request('/api/saved-queries');
    expect(res.status).toBe(401);
  });

  it('previews an api url without saving (POST /preview-url)', async () => {
    const res = await app.request(
      '/api/saved-queries/preview-url',
      json('POST', { collection: COLLECTION, config: CONFIG }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api_url: string };
    expect(typeof body.api_url).toBe('string');
  });

  it('executes an ad-hoc query (POST /execute)', async () => {
    const res = await app.request(
      '/api/saved-queries/execute',
      json('POST', { collection: COLLECTION, config: CONFIG }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collection: string };
    expect(body.collection).toBe(COLLECTION);
  });

  it('404s executing against a missing collection', async () => {
    const res = await app.request(
      '/api/saved-queries/execute',
      json('POST', { collection: 'does_not_exist_xyz', config: CONFIG }),
    );
    expect(res.status).toBe(404);
  });

  it('saves a query (POST /) and returns an id', async () => {
    const res = await app.request(
      '/api/saved-queries',
      json('POST', {
        name: 'Harness Saved Query',
        description: 'from the harness',
        collection: COLLECTION,
        config: CONFIG,
        is_shared: false,
      }),
    );
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as {
      query?: { id: string };
      data?: { id: string };
      id?: string;
    };
    const id = body.query?.id ?? body.data?.id ?? body.id;
    expect(id).toBeDefined();
    queryId = id!;
  });

  it('lists saved queries (GET /) including the new one', async () => {
    const res = await app.request('/api/saved-queries', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queries?: Array<{ id: string }> };
    const list = body.queries ?? (body as unknown as Array<{ id: string }>);
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((q) => q.id === queryId)).toBe(true);
  });

  it('fetches a single saved query (GET /:id)', async () => {
    const res = await app.request(`/api/saved-queries/${queryId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('updates a saved query (PUT /:id)', async () => {
    const res = await app.request(
      `/api/saved-queries/${queryId}`,
      json('PUT', { name: 'Harness Saved Query (renamed)' }),
    );
    expect([200, 204]).toContain(res.status);
  });

  it('runs a saved query (POST /:id/run)', async () => {
    const res = await app.request(`/api/saved-queries/${queryId}/run`, json('POST', {}));
    expect(res.status).toBeLessThan(500);
  });

  it('deletes a saved query (DELETE /:id) and then 404s', async () => {
    const del = await app.request(`/api/saved-queries/${queryId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);
    const gone = await app.request(`/api/saved-queries/${queryId}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });
});
