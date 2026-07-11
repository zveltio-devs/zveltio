/**
 * Phase C — /api/api-keys CRUD (routes/admin.ts apiKeysRoutes).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('API keys routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let keyId: string;
  let rawKey: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db || !keyId) return;
    await db
      .deleteFrom('zv_api_key_access_log')
      .where('api_key_id', '=', keyId)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_api_keys')
      .where('id', '=', keyId)
      .execute()
      .catch(() => {});
  });

  it('GET /api/api-keys lists keys for admin', async () => {
    const res = await app.request('/api/api-keys', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { api_keys: unknown[] };
    expect(Array.isArray(body.api_keys)).toBe(true);
  });

  it('POST /api/api-keys creates a key and returns the raw secret once', async () => {
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness Key ${Date.now()}`,
        scopes: [{ collection: '*', actions: ['read'] }],
        rate_limit: 500,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; key: string; key_prefix: string };
    keyId = body.id;
    rawKey = body.key;
    expect(rawKey.startsWith('zvk_')).toBe(true);
    expect(body.key_prefix).toBe(rawKey.substring(0, 12));
  });

  it('DELETE /api/api-keys/:id revokes the key', async () => {
    const res = await app.request(`/api/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    keyId = '';
  });

  it('rejects unauthenticated key listing', async () => {
    const res = await app.request('/api/api-keys');
    expect(res.status).toBe(401);
  });
});
