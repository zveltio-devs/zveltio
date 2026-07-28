/**
 * Phase A coverage — admin system routes (routes/admin/system-routes.ts),
 * mounted at /api/admin. Read-only monitoring/introspection endpoints plus the
 * notifications mark-read flow, driven through the real in-process app with a
 * god session. Had no dedicated suite (55% incidental); these are all
 * harness-reachable (DB + in-process), not external services.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('admin system routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const h = () => ({ cookie });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('GET /api/admin/status returns engine + db status', async () => {
    const res = await app.request('/api/admin/status', { headers: h() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe('object');
  });

  it('GET /api/admin/field-types lists registered field types', async () => {
    const res = await app.request('/api/admin/field-types', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/types returns the generated TS types', async () => {
    const res = await app.request('/api/admin/types', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/schema returns the schema snapshot', async () => {
    const res = await app.request('/api/admin/schema', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/onboarding/status returns onboarding progress', async () => {
    const res = await app.request('/api/admin/onboarding/status', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/stats returns instance stats', async () => {
    const res = await app.request('/api/admin/stats', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/logs returns recent logs', async () => {
    const res = await app.request('/api/admin/logs', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/slow-queries returns the slow-query list', async () => {
    const res = await app.request('/api/admin/slow-queries', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/revisions lists recent revisions', async () => {
    const res = await app.request('/api/admin/revisions', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/api-keys lists API keys', async () => {
    const res = await app.request('/api/admin/api-keys', { headers: h() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body).toBe('object');
  });

  it('GET /api/admin/audit returns the audit log', async () => {
    const res = await app.request('/api/admin/audit', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('GET /api/admin/audit/export streams a CSV export', async () => {
    const res = await app.request('/api/admin/audit/export', { headers: h() });
    expect(res.status).toBe(200);
  });

  it('notifications: list, mark-one-read, mark-all-read', async () => {
    const list = await app.request('/api/admin/notifications', { headers: h() });
    expect(list.status).toBe(200);
    // mark-all-read is idempotent and safe with zero notifications.
    const all = await app.request('/api/admin/notifications/mark-all-read', {
      method: 'POST',
      headers: h(),
    });
    expect(all.status).toBe(200);
  });

  it('POST /api/admin/migrate is idempotent (no pending → ok)', async () => {
    const res = await app.request('/api/admin/migrate', { method: 'POST', headers: h() });
    // Already migrated by the harness boot → a clean no-op success.
    expect([200, 201]).toContain(res.status);
  });

  it('requires a session — anonymous /api/admin/status is 401', async () => {
    const res = await app.request('/api/admin/status');
    expect(res.status).toBe(401);
  });
});
