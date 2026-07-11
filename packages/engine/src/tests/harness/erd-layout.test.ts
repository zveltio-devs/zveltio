/**
 * Phase C — /api/erd/layout (routes/erd-layout.ts).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('ERD layout routes (in-process)', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    cookie = await createGodSession(app, ctx.db);
  });

  it('GET /api/erd/layout returns the user position map', async () => {
    const res = await app.request('/api/erd/layout', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { positions: Record<string, { x: number; y: number }> };
    expect(typeof body.positions).toBe('object');
  });

  it('PUT /api/erd/layout replaces positions for the current user', async () => {
    const res = await app.request('/api/erd/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        positions: {
          articles: { x: 120, y: 80 },
          customers: { x: 400, y: 80 },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; count: number };
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);
  });

  it('DELETE /api/erd/layout clears saved positions', async () => {
    const res = await app.request('/api/erd/layout', {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('rejects unauthenticated layout access', async () => {
    const res = await app.request('/api/erd/layout');
    expect(res.status).toBe(401);
  });
});
