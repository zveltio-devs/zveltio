/**
 * query-cache.ts — backend failures are swallowed (non-critical cache writes).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import {
  buildQueryCacheKey,
  getQueryCache,
  invalidateQueryCache,
  invalidateQueryCacheForCollection,
  invalidateUserQueryCache,
  setQueryCache,
} from '../../lib/data/query-cache.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';

afterEach(() => {
  _setCacheForTests(null);
});

function failingRedis() {
  return {
    get: async () => {
      throw new Error('get down');
    },
    setex: async () => {
      throw new Error('setex down');
    },
    sadd: async () => {
      throw new Error('sadd down');
    },
    smembers: async () => {
      throw new Error('smembers down');
    },
    del: async () => {
      throw new Error('del down');
    },
    scan: async () => {
      throw new Error('scan down');
    },
    expire: async () => 1,
  };
}

describe('query cache — backend failure tolerance', () => {
  it('getQueryCache returns null when the backend throws', async () => {
    _setCacheForTests(failingRedis() as unknown as Redis);
    expect(await getQueryCache('qc:_:c:abc')).toBeNull();
  });

  it('setQueryCache resolves when setex throws', async () => {
    _setCacheForTests(failingRedis() as unknown as Redis);
    await expect(setQueryCache('qc:_:c:abc', { rows: [] }, 'u1')).resolves.toBeUndefined();
  });

  it('invalidate helpers resolve when the backend throws', async () => {
    _setCacheForTests(failingRedis() as unknown as Redis);
    await expect(invalidateUserQueryCache('u1')).resolves.toBeUndefined();
    await expect(invalidateQueryCache('contacts', 't1')).resolves.toBeUndefined();
    await expect(invalidateQueryCacheForCollection('contacts')).resolves.toBeUndefined();
  });

  it('skips oversized payloads without touching a healthy backend', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      setex: async (key: string, _ttl: number, val: string) => {
        store.set(key, val);
        return 'OK';
      },
      sadd: async () => 1,
      expire: async () => 1,
    };
    _setCacheForTests(redis as unknown as Redis);
    const key = buildQueryCacheKey('big', 'u1', '?all=1', null);
    await setQueryCache(key, { blob: 'x'.repeat(600 * 1024) }, 'u1');
    expect(store.has(key)).toBe(false);
  });
});
