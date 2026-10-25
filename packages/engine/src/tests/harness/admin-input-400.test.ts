/**
 * A caller's bad input answers 400, not 500.
 *
 * PATCH /api/admin/api-keys/:id with `{}` reached SQL as an empty SET, and
 * POST /api/admin/explain on a collection or sort column that does not exist
 * returned the raw Postgres error as a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin routes answer 400 for bad input (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let keyId: string | undefined;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (keyId) await sql`DELETE FROM zv_api_keys WHERE id = ${keyId}`.execute(db);
  });

  const post = (path: string, body: unknown, method = 'POST') =>
    app.request(path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('PATCH an API key with nothing to set', async () => {
    const made = await post('/api/admin/api-keys', { name: `empty-patch-${Date.now()}` });
    expect(made.status).toBe(200);
    keyId = ((await made.json()) as { id: string }).id;
    const res = await post(`/api/admin/api-keys/${keyId}`, {}, 'PATCH');
    expect(res.status).toBe(400);
  });

  it('explain on a collection that does not exist', async () => {
    const res = await post('/api/admin/explain', { collection: `nope_${Date.now()}` });
    expect(res.status).toBe(400);
  });

  it('explain on a sort column that does not exist', async () => {
    // zv_ engine tables are refused by the name pattern; zvd_permissions is a
    // collection-shaped table every install has.
    const res = await post('/api/admin/explain', {
      collection: 'permissions',
      sort: 'no_such_col',
    });
    expect(res.status).toBe(400);
  });
});
