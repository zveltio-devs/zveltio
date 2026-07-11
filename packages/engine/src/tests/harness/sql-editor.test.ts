/**
 * Phase C — /api/admin/sql (routes/sql-editor.ts + audit).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin SQL editor (in-process)', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    cookie = await createGodSession(app, ctx.db);
  });

  it('POST /api/admin/sql runs a read-only query', async () => {
    const res = await app.request('/api/admin/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ query: 'SELECT 1 AS one', timeout_ms: 5000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ one: number }>; rowCount: number };
    expect(body.rowCount).toBeGreaterThanOrEqual(1);
    expect(body.rows[0]?.one).toBe(1);
  });

  it('rejects unauthenticated SQL execution', async () => {
    const res = await app.request('/api/admin/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1' }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
