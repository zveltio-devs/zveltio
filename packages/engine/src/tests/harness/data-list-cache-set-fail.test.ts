/**
 * Phase C — list handler tolerates setQueryCache failures (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcachefail_${Date.now()}`;

class FailingSetexRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setex(_key: string, _ttl: number, _val: string): Promise<'OK'> {
    throw new Error('valkey write down');
  }

  async sadd(): Promise<number> {
    return 0;
  }

  async expire(): Promise<number> {
    return 1;
  }
}

d('data list query-cache set failure (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    process.env.QUERY_CACHE_TTL_SECONDS = '30';
    _setCacheForTests(new FailingSetexRedis() as unknown as Redis);
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'cache-row' }),
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

  it('still returns 200 when writing the query cache fails', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: unknown[] };
      expect(body.records.length).toBeGreaterThan(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('setQueryCache failed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
