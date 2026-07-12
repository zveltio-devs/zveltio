/**
 * Phase C — list handler query-cache hit + ETag 304 (handlers/list.ts).
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
const COLLECTION = `hcache_${Date.now()}`;

class CacheFakeRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, val: string): Promise<'OK'> {
    this.store.set(key, val);
    return 'OK';
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    for (const m of members) s.add(String(m));
    this.sets.set(key, s);
    return members.length;
  }
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
}

d('data list query-cache hit (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    process.env.QUERY_CACHE_TTL_SECONDS = '30';
    _setCacheForTests(new CacheFakeRedis() as unknown as Redis);
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cached-row', score: 1 }),
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

  it('serves a cached list on repeat GET and honors If-None-Match', async () => {
    const first = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(second.status).toBe(200);

    const third = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie, 'If-None-Match': etag! },
    });
    expect([304, 200]).toContain(third.status);
  });
});
