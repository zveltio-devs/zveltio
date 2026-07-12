/**
 * Phase C — API-key authentication on /api/data (lib/data/auth.ts end-to-end).
 *
 * Creates a scoped key via admin routes, then exercises read vs write enforcement
 * through the in-process app harness (no external HTTP server).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hapikey_${Date.now()}`;

d('data API-key scopes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let rawKey: string;
  let keyId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    const keyRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness data key ${Date.now()}`,
        scopes: [{ collection: COLLECTION, actions: ['read'] }],
      }),
    });
    expect(keyRes.status).toBe(200);
    const body = (await keyRes.json()) as { id: string; key: string };
    keyId = body.id;
    rawKey = body.key;
    expect(rawKey.startsWith('zvk_')).toBe(true);
  });

  afterAll(async () => {
    if (db) {
      if (keyId) {
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
      }
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  const withKey = (init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), 'X-API-Key': rawKey },
  });

  it('GET /api/data/:collection succeeds with a read-scoped API key', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, withKey());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: unknown[] };
    expect(Array.isArray(body.records)).toBe(true);
  });

  it('POST /api/data/:collection is forbidden when the key lacks write scope', async () => {
    const res = await app.request(
      `/api/data/${COLLECTION}`,
      withKey({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'blocked by scope' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects requests with an invalid API key', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': 'zvk_invalid_key_for_harness_test' },
    });
    expect(res.status).toBe(401);
  });
});
