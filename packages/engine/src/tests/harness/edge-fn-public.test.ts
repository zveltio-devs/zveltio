/**
 * Phase C — public edge function invoke at /api/fn/:name.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FN = `pub-fn-${Date.now()}`;
const CODE = `async function handler(req) {
  return { status: 200, body: { echo: req.body?.ping ?? false } };
}`;

d('public edge function invoke (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let fnId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    const create = await app.request('/api/edge-functions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: FN,
        display_name: 'Public Harness Fn',
        code: CODE,
        http_method: 'POST',
      }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { function: { id: string } };
    fnId = body.function.id;
  });

  afterAll(async () => {
    if (!db || !fnId) return;
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
  });

  it('POST /api/fn/:name invokes with session auth', async () => {
    const res = await app.request(`/api/fn/${FN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ping: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echo?: boolean };
    expect(body.echo).toBe(true);
  });

  it('rejects unauthenticated invoke', async () => {
    const res = await app.request(`/api/fn/${FN}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown function name', async () => {
    const res = await app.request('/api/fn/no-such-fn-xyz', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
