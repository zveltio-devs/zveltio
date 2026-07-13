/**
 * createCacheSecondaryStorage (lib/runtime/cache.ts) — JSON get/set/pipeline over fake Redis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _setCacheForTests, createCacheSecondaryStorage } from '../../lib/runtime/cache.js';

function makeCache(store = new Map<string, string>()) {
  const pipelineOps: Array<{ cmd: string; args: unknown[] }> = [];
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    set: async (...args: unknown[]) => {
      const key = String(args[0]);
      const hasNx = args.includes('NX');
      if (hasNx && store.has(key)) return null;
      if (args.length >= 2) store.set(key, String(args[1]));
      return 'OK';
    },
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    pipeline: () => {
      const chain = {
        get(key: string) {
          pipelineOps.push({ cmd: 'get', args: [key] });
          return chain;
        },
        setex(key: string, ttl: number, value: string) {
          pipelineOps.push({ cmd: 'setex', args: [key, ttl, value] });
          return chain;
        },
        del(key: string) {
          pipelineOps.push({ cmd: 'del', args: [key] });
          return chain;
        },
        async exec() {
          return pipelineOps.map((op) => {
            if (op.cmd === 'get') return [null, store.get(String(op.args[0])) ?? null];
            if (op.cmd === 'setex') {
              store.set(String(op.args[0]), String(op.args[2]));
              return [null, 'OK'];
            }
            if (op.cmd === 'del') {
              store.delete(String(op.args[0]));
              return [null, 1];
            }
            return [null, null];
          });
        },
      };
      return chain;
    },
  };
}

beforeEach(() => {
  delete process.env.VALKEY_URL;
});

afterEach(() => {
  _setCacheForTests(null);
});

describe('createCacheSecondaryStorage', () => {
  it('returns null when no cache is available', async () => {
    expect(await createCacheSecondaryStorage()).toBeNull();
  });

  it('get/set/delete round-trip JSON values', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(storage).not.toBeNull();

    await storage!.set('k1', { ok: true }, 60);
    expect(await storage!.get('k1')).toEqual({ ok: true });
    await storage!.delete('k1');
    expect(await storage!.get('k1')).toBeNull();
  });

  it('treats corrupted JSON as a cache miss', async () => {
    const fake = makeCache(new Map([['bad', 'not-json']]));
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(await storage!.get('bad')).toBeNull();
  });

  it('setnx writes only when the key is absent', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    await storage!.set('nx-key', { first: true });
    await storage!.setnx('nx-key', { second: true });
    expect(await storage!.get('nx-key')).toEqual({ first: true });
    await storage!.delete('nx-key');
    await storage!.setnx('nx-key', { fresh: true });
    expect(await storage!.get('nx-key')).toEqual({ fresh: true });
  });

  it('runs pipeline get/set/del operations', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    const results = await storage!.pipeline([
      { type: 'set', key: 'a', value: { n: 1 }, ttl: 30 },
      { type: 'get', key: 'a' },
      { type: 'del', key: 'a' },
    ]);
    expect(results[0]).toBe('OK');
    expect(results[1]).toBe('{"n":1}');
    expect(await storage!.get('a')).toBeNull();
  });

  it('returns an empty array when pipeline exec yields null', async () => {
    const fake = makeCache();
    fake.pipeline = () => ({
      get() {
        return this;
      },
      setex() {
        return this;
      },
      del() {
        return this;
      },
      exec: async () => null as never,
    });
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(await storage!.pipeline([{ type: 'get', key: 'missing' }])).toEqual([]);
  });
});
