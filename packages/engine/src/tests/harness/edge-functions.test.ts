/**
 * Phase C — /api/edge-functions (routes/edge-functions.ts + edge-function-runner.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FN = `harness-fn-${Date.now()}`;
const CODE = `async function handler() {
  return { status: 200, body: { pong: true } };
}`;

d('edge functions routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let fnId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && fnId) {
      await db
        .deleteFrom('zv_edge_function_logs')
        .where('function_id', '=', fnId)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zv_edge_functions')
        .where('id', '=', fnId)
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/edge-functions lists registered functions', async () => {
    const res = await app.request('/api/edge-functions', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { functions: unknown[] };
    expect(Array.isArray(body.functions)).toBe(true);
  });

  it('POST /api/edge-functions creates a function', async () => {
    const res = await app.request('/api/edge-functions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: FN,
        display_name: 'Harness Ping',
        code: CODE,
        http_method: 'POST',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { function: { id: string; name: string } };
    fnId = body.function.id;
    expect(body.function.name).toBe(FN);
  });

  it('POST /api/edge-functions/:id/invoke runs the handler in-process', async () => {
    const res = await app.request(`/api/edge-functions/${fnId}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ probe: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean; body: { pong?: boolean } } };
    expect(body.result.ok).toBe(true);
    expect(body.result.body?.pong).toBe(true);
  });

  it('GET /api/edge-functions/:id/logs returns invocation logs', async () => {
    const res = await app.request(`/api/edge-functions/${fnId}/logs`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[] };
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it('DELETE /api/edge-functions/:id removes the function', async () => {
    const res = await app.request(`/api/edge-functions/${fnId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    fnId = '';
  });
});
