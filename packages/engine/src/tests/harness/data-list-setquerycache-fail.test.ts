/**
 * Phase C — list handler logs setQueryCache rejections (handlers/list.ts .catch).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import * as queryCache from '../../lib/data/query-cache.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsqc_${Date.now()}`;

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

d('data list setQueryCache failure (in-process)', () => {
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
      body: JSON.stringify({ label: 'seed', score: 1 }),
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

  afterEach(() => {
    spyOn(queryCache, 'setQueryCache').mockRestore();
  });

  it('still returns 200 when setQueryCache rejects', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    spyOn(queryCache, 'setQueryCache').mockRejectedValue(new Error('valkey write down'));
    try {
      const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: unknown[] };
      expect(body.records.length).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 25));
      expect(
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes(`setQueryCache failed for ${COLLECTION}`),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
