/**
 * Phase C — /api/settings (routes/settings.ts public + admin upsert paths).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const KEY = `site_name_harness_${Date.now()}`;

d('settings routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db) {
      await db
        .deleteFrom('zv_settings')
        .where('key', '=', 'site_name')
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/settings/public returns whitelisted public settings', async () => {
    const res = await app.request('/api/settings/public');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  it('GET /api/settings lists all settings for admins', async () => {
    const res = await app.request('/api/settings', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  it('PUT /api/settings/:key upserts a writable setting', async () => {
    const res = await app.request('/api/settings/site_name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: KEY, is_public: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; value: string };
    expect(body.success).toBe(true);
    expect(body.value).toBe(KEY);
  });

  it('PATCH /api/settings/bulk updates multiple writable keys', async () => {
    const res = await app.request('/api/settings/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ timezone: 'UTC', language: 'en' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; updated: string[] };
    expect(body.success).toBe(true);
    expect(body.updated).toContain('timezone');
  });

  it('rejects writes to readonly settings keys', async () => {
    const res = await app.request('/api/settings/auth_secret', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ value: 'nope' }),
    });
    expect(res.status).toBe(403);
  });
});
