/**
 * Phase C — list query-cache hit returns 304 on matching If-None-Match (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlc304_${Date.now()}`;

class CacheFakeRedis {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, val: string): Promise<'OK'> {
    this.store.set(key, val);
    return 'OK';
  }
  async sadd(): Promise<number> {
    return 1;
  }
  async expire(): Promise<number> {
    return 1;
  }
}

d('data list query-cache 304 strict (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const fakeRedis = new CacheFakeRedis();

  beforeAll(async () => {
    process.env.QUERY_CACHE_TTL_SECONDS = '30';
    _setCacheForTests(fakeRedis as unknown as Redis);
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cached-row' }),
    });
  });

  afterAll(async () => {
    _setCacheForTests(null);
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('returns 304 from the cache-hit branch when If-None-Match matches', async () => {
    const warm = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(warm.status).toBe(200);
    expect(fakeRedis.store.size).toBeGreaterThan(0);

    const cached = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(cached.status).toBe(200);
    const etag = cached.headers.get('etag');
    expect(etag).toBeTruthy();

    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie, 'If-None-Match': etag! },
    });
    expect(res.status).toBe(304);
  });
});
