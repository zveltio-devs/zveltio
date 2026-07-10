/**
 * Valkey secondary-storage adapter (lib/runtime/cache.ts) — get/set/setnx/delete/
 * pipeline with JSON serialization and corrupted-entry handling. Driven with a
 * fake Redis injected via _setCacheForTests (no live Valkey).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import {
  _setCacheForTests,
  createCacheSecondaryStorage,
  getCache,
  initCache,
} from '../../lib/runtime/cache.js';

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for cache under test
type Args = any[];

class FakeRedis {
  store = new Map<string, string>();
  setexCalls: Args[] = [];
  setCalls: Args[] = [];
  delCalls: Args[] = [];
  pipelineOps: Args[][] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(...a: Args): Promise<'OK'> {
    this.setexCalls.push(a);
    this.store.set(String(a[0]), String(a[2]));
    return 'OK';
  }
  async set(...a: Args): Promise<'OK' | null> {
    this.setCalls.push(a);
    const key = String(a[0]);
    const hasNx = a.includes('NX');
    if (hasNx && this.store.has(key)) return null;
    this.store.set(key, String(a[1]));
    return 'OK';
  }
  async del(...a: Args): Promise<number> {
    this.delCalls.push(a);
    for (const k of a) this.store.delete(String(k));
    return 1;
  }
  pipeline() {
    const ops: Args[] = [];
    const self = this;
    const pipe = {
      get(key: string) {
        ops.push(['get', key]);
        return pipe;
      },
      setex(key: string, ttl: number, value: string) {
        ops.push(['setex', key, ttl, value]);
        return pipe;
      },
      del(key: string) {
        ops.push(['del', key]);
        return pipe;
      },
      async exec() {
        self.pipelineOps.push(ops);
        return ops.map((op) => {
          if (op[0] === 'get') return [null, self.store.get(String(op[1])) ?? null];
          if (op[0] === 'setex') {
            self.store.set(String(op[1]), String(op[3]));
            return [null, 'OK'];
          }
          if (op[0] === 'del') {
            self.store.delete(String(op[1]));
            return [null, 1];
          }
          return [null, null];
        });
      },
    };
    return pipe;
  }
}

const origValkey = process.env.VALKEY_URL;

beforeEach(() => {
  _setCacheForTests(null);
  delete process.env.VALKEY_URL;
});

afterEach(() => {
  _setCacheForTests(null);
  if (origValkey === undefined) delete process.env.VALKEY_URL;
  else process.env.VALKEY_URL = origValkey;
});

describe('cache singleton helpers', () => {
  it('getCache returns null before init or injection', () => {
    expect(getCache()).toBeNull();
  });

  it('initCache is a no-op without VALKEY_URL', async () => {
    expect(await initCache()).toBeNull();
    expect(getCache()).toBeNull();
  });

  it('createCacheSecondaryStorage returns null without a backend', async () => {
    expect(await createCacheSecondaryStorage()).toBeNull();
  });
});

describe('createCacheSecondaryStorage', () => {
  it('reuses an injected cache via getCache()', async () => {
    const redis = new FakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const storage = await createCacheSecondaryStorage();
    expect(storage).not.toBeNull();

    await storage!.set('k1', { n: 1 }, 60);
    expect(redis.setexCalls[0]).toEqual(['k1', 60, '{"n":1}']);
    expect(await storage!.get('k1')).toEqual({ n: 1 });

    await storage!.delete('k1');
    expect(redis.delCalls[0]).toEqual(['k1']);
    expect(await storage!.get('k1')).toBeNull();
  });

  it('setnx writes only when the key is absent', async () => {
    const redis = new FakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const storage = await createCacheSecondaryStorage();

    await storage!.setnx('lock', { ok: true });
    await storage!.setnx('lock', { ok: false });
    expect(await storage!.get('lock')).toEqual({ ok: true });
  });

  it('treats corrupted JSON as a cache miss', async () => {
    const redis = new FakeRedis();
    redis.store.set('bad', 'not-json{');
    _setCacheForTests(redis as unknown as Redis);
    const storage = await createCacheSecondaryStorage();
    expect(await storage!.get('bad')).toBeNull();
  });

  it('pipeline batches get/set/del in one roundtrip', async () => {
    const redis = new FakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const storage = await createCacheSecondaryStorage();

    const results = await storage!.pipeline([
      { type: 'set', key: 'a', value: { x: 1 }, ttl: 10 },
      { type: 'get', key: 'a' },
      { type: 'del', key: 'a' },
    ]);
    expect(results).toEqual(['OK', '{"x":1}', 1]);
    expect(redis.pipelineOps.length).toBe(1);
  });
});
