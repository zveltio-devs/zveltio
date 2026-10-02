/**
 * Phase C — /api/admin config routes (routes/admin/config-routes.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcolperm_${Date.now()}`;

d('admin config routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let colPermId: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    db = ctx.db;
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && colPermId) {
      await db
        .deleteFrom('zvd_column_permissions')
        .where('id', '=', colPermId)
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/admin/rate-limits lists configured tiers', async () => {
    const res = await app.request('/api/admin/rate-limits', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rate_limits?: unknown[] };
    expect(Array.isArray(body.rate_limits)).toBe(true);
    expect((body.rate_limits ?? []).length).toBeGreaterThan(0);
  });

  it('POST /api/admin/rate-limits/reset restores default tiers', async () => {
    const res = await app.request('/api/admin/rate-limits/reset', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('reset actually puts a changed tier back to its compiled default', async () => {
    // Shape alone passed with a reset that wrote nothing.
    await sql`
      INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
      VALUES ('api', 1000, 7)
      ON CONFLICT (key_prefix) DO UPDATE SET window_ms = 1000, max_requests = 7
    `.execute(db);
    const res = await app.request('/api/admin/rate-limits/reset', {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const row = await sql<{ window_ms: number; max_requests: number }>`
      SELECT window_ms, max_requests FROM zv_rate_limit_configs WHERE key_prefix = 'api'
    `.execute(db);
    expect(row.rows[0]).toEqual({ window_ms: 60_000, max_requests: 200 });
  });

  it('GET /api/admin/column-permissions lists column-level rules', async () => {
    const res = await app.request('/api/admin/column-permissions', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { column_permissions?: unknown[] };
    expect(Array.isArray(body.column_permissions)).toBe(true);
  });

  it('POST /api/admin/column-permissions creates a column rule', async () => {
    const res = await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection_name: COLLECTION,
        column_name: 'title',
        role: 'admin',
        can_read: true,
        can_write: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { column_permission: { id: string } };
    colPermId = body.column_permission.id;
    expect(colPermId).toBeDefined();
  });

  it('PUT /api/admin/column-permissions/:id updates the rule', async () => {
    const res = await app.request(`/api/admin/column-permissions/${colPermId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ can_write: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { column_permission: { can_write: boolean } };
    expect(body.column_permission.can_write).toBe(true);
  });

  it('DELETE /api/admin/column-permissions/:id removes the rule', async () => {
    const res = await app.request(`/api/admin/column-permissions/${colPermId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const left = await sql`SELECT 1 FROM zvd_column_permissions WHERE id = ${colPermId}`.execute(
      db,
    );
    expect(left.rows).toHaveLength(0);
    colPermId = '';
  });

  it('GET /api/admin/logs returns recent request log rows', async () => {
    const res = await app.request('/api/admin/logs?limit=5', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs?: unknown[]; total?: number };
    expect(Array.isArray(body.logs)).toBe(true);
    expect(typeof body.total).toBe('number');
  });
});
