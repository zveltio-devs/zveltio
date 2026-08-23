/**
 * Phase C — public edge function invoke at `/api/fn/:name`.
 *
 * `/api/fn` is the engine's and stays the engine's: the extension defers to it
 * on purpose (it authenticates a session OR a tenant-bound API key, resolves
 * the function per request so a new one answers immediately, and applies the
 * anonymous rate limit). CRUD is the extension's. These assertions are about
 * the invoke half only.
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

    // Seeded straight into the table rather than through `/api/edge-functions`,
    // which this engine no longer serves: CRUD belongs to
    // extensions/developer/edge-functions and the engine's copy is a 410 shim.
    // The subject here is `/api/fn`, which IS the engine's, so the fixture is
    // set up by the shortest honest route rather than by a second product.
    const row = await db
      .insertInto('zv_edge_functions')
      .values({
        name: FN,
        display_name: 'Public Harness Fn',
        code: CODE,
        http_method: 'POST',
        // NOT NULL, and derived from the name by the CRUD route this no longer
        // goes through — so it has to be spelled out here.
        path: `/api/fn/${FN}`,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    fnId = (row as { id: string }).id;
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
