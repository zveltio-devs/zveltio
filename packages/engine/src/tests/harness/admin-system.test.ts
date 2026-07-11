/**
 * Phase C — /api/admin system routes (routes/admin/system-routes.ts).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin system routes (in-process)', () => {
  let app: Hono;
  let cookie: string;

  beforeAll(async () => {
    const ctx = await getTestApp();
    app = ctx.app;
    cookie = await createGodSession(app, ctx.db);
  });

  it('GET /api/admin/status returns database and cache health', async () => {
    const res = await app.request('/api/admin/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; database: { status: string } };
    expect(body.status).toBe('ok');
    expect(body.database.status).toBe('connected');
  });

  it('GET /api/admin/field-types returns the registry', async () => {
    const res = await app.request('/api/admin/field-types', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it('GET /api/admin/schema returns collection metadata', async () => {
    const res = await app.request('/api/admin/schema', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections?: unknown[] };
    expect(Array.isArray(body.collections)).toBe(true);
  });

  it('GET /api/admin/stats returns engine counters', async () => {
    const res = await app.request('/api/admin/stats', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  it('GET /api/admin/audit returns recent audit rows', async () => {
    const res = await app.request('/api/admin/audit?limit=5', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit?: unknown[] };
    expect(Array.isArray(body.audit)).toBe(true);
  });

  it('rejects unauthenticated admin status', async () => {
    const res = await app.request('/api/admin/status');
    expect([401, 403]).toContain(res.status);
  });
});
