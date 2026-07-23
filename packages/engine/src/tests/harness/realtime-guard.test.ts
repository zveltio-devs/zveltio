/**
 * Phase C — realtime SSE route: the auth gate on /stream. The streaming body
 * (pg_notify / Valkey fan-out) is exercised by integration/soak; here we cover
 * the authentication branch that guards it. Drives routes/realtime.ts.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('realtime stream guard (in-process)', () => {
  let app: Hono;
  let db: Database;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await createGodSession(app, db);
  });

  it('rejects an unauthenticated SSE stream (GET /stream)', async () => {
    const res = await app.request('/api/realtime/stream');
    expect(res.status).toBe(401);
  });

  it('rejects an unauthenticated stream with query params', async () => {
    const res = await app.request('/api/realtime/stream?collection=user&channel=broadcast:x');
    expect(res.status).toBe(401);
  });
});
