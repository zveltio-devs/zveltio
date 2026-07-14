/**
 * Phase C — edge functions tenant isolation. Regression: zv_edge_functions /
 * zv_edge_function_logs had no tenant_id and routes/edge-functions.ts listed them and
 * reached them by id (and by name on the public /api/fn path) unscoped, so any
 * tenant's admin could list/read/patch/delete/invoke another tenant's functions —
 * which store secrets in env_vars and run arbitrary code — and read their logs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000ea';
const STAMP = Date.now();
const FOREIGN_NAME = `foreign-fn-${STAMP}`;

d('edge functions tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let mineId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A function (+ log) belonging to ANOTHER tenant, inserted directly. Raw SQL to
    // rely on the DB defaults (runtime) and the INTEGER status column.
    await sql`
      INSERT INTO zv_edge_functions
        (id, tenant_id, name, display_name, code, http_method, path, is_active, timeout_ms, env_vars)
      VALUES (${FOREIGN_ID}, ${OTHER_TENANT}, ${FOREIGN_NAME}, 'Foreign',
        'async function handler(){return {status:200,body:{}}}', 'POST',
        ${`/api/fn/${FOREIGN_NAME}`}, true, 30000,
        ${JSON.stringify({ SECRET: 'other-tenant-secret' })}::jsonb)
    `.execute(db);
    await sql`
      INSERT INTO zv_edge_function_logs (tenant_id, function_id, status, duration_ms)
      VALUES (${OTHER_TENANT}, ${FOREIGN_ID}, 200, 1)
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_edge_function_logs WHERE function_id = ${FOREIGN_ID}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_edge_functions WHERE id = ${FOREIGN_ID}`.execute(db).catch(() => {});
    if (mineId)
      await sql`DELETE FROM zv_edge_functions WHERE id = ${mineId}`.execute(db).catch(() => {});
  });

  it('single-tenant: list hides the other tenant’s function', async () => {
    const res = await app.request('/api/edge-functions', { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { functions: { id: string }[] }).functions.map((f) => f.id);
    expect(ids).not.toContain(FOREIGN_ID);
  });

  it('cross-tenant: GET /:id of another tenant’s function → 404', async () => {
    const res = await app.request(`/api/edge-functions/${FOREIGN_ID}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: PATCH /:id does not modify another tenant’s function', async () => {
    const res = await app.request(
      `/api/edge-functions/${FOREIGN_ID}`,
      json('PATCH', { code: 'x' }),
    );
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zv_edge_functions')
      .select('code')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.code).not.toBe('x'); // untouched
  });

  it('cross-tenant: POST /:id/invoke does not run another tenant’s function', async () => {
    const res = await app.request(`/api/edge-functions/${FOREIGN_ID}/invoke`, json('POST', {}));
    expect(res.status).toBe(404);
  });

  it('cross-tenant: GET /:id/logs does not leak another tenant’s logs', async () => {
    const res = await app.request(`/api/edge-functions/${FOREIGN_ID}/logs`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const logs = ((await res.json()) as { logs: unknown[] }).logs;
    expect(logs.length).toBe(0);
  });

  it('cross-tenant: DELETE /:id does not remove another tenant’s function', async () => {
    const res = await app.request(`/api/edge-functions/${FOREIGN_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zv_edge_functions')
      .select('id')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_ID); // untouched
  });

  it('allows the same function name in a different tenant (per-tenant UNIQUE)', async () => {
    // The foreign tenant already owns FOREIGN_NAME; this tenant may reuse it.
    const res = await app.request(
      '/api/edge-functions',
      json('POST', { name: FOREIGN_NAME, display_name: 'Mine', code: 'code' }),
    );
    expect(res.status).toBe(201);
    mineId = ((await res.json()) as { function: { id: string } }).function.id;
  });
});
