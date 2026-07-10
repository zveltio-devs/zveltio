/**
 * Query-response cache (lib/data/query-cache.ts) — the pure cache-key builder +
 * the no-op guards when no cache backend is configured (getCache() → null when
 * VALKEY_URL is unset, which is the unit-test environment). Live Valkey hit/miss
 * behaviour is covered by the query-cache integration test.
 */

import { describe, it, expect, afterEach } from 'bun:test';
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

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for cache under test
type Args = any[];

class QueryCacheFakeRedis {
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
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
  async del(...keys: Args): Promise<number> {
    for (const k of keys) {
      this.store.delete(String(k));
      this.sets.delete(String(k));
    }
    return keys.length;
  }
  async scan(cursor: string, _op: string, pattern: string, _countOp: string, _count: number) {
    const re = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    const matches = [...this.sets.keys()].filter((k) => re.test(k));
    return [cursor === '0' && matches.length > 0 ? '0' : '0', matches] as [string, string[]];
  }
}

afterEach(() => {
  _setCacheForTests(null);
});

describe('buildQueryCacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = buildQueryCacheKey('contacts', 'u1', '?limit=10', 't1');
    const b = buildQueryCacheKey('contacts', 'u1', '?limit=10', 't1');
    expect(a).toBe(b);
  });

  it('is prefixed qc: and includes the collection', () => {
    const k = buildQueryCacheKey('orders', 'u1', '?x=1', 't1');
    expect(k.startsWith('qc:')).toBe(true);
    expect(k).toContain('orders');
  });

  it('changes with the query string, user, tenant, and collection', () => {
    const base = buildQueryCacheKey('c', 'u', '?q=1', 't');
    expect(buildQueryCacheKey('c', 'u', '?q=2', 't')).not.toBe(base);
    expect(buildQueryCacheKey('c', 'u2', '?q=1', 't')).not.toBe(base);
    expect(buildQueryCacheKey('c', 'u', '?q=1', 't2')).not.toBe(base);
    expect(buildQueryCacheKey('c2', 'u', '?q=1', 't')).not.toBe(base);
  });

  it('a null tenant still produces a valid, distinct key', () => {
    const k = buildQueryCacheKey('c', 'u', '?q=1', null);
    expect(k.startsWith('qc:')).toBe(true);
    expect(k).not.toBe(buildQueryCacheKey('c', 'u', '?q=1', 't'));
  });
});

describe('cache ops are safe no-ops without a backend (getCache → null)', () => {
  it('getQueryCache returns null', async () => {
    expect(await getQueryCache('qc:_:c:abc')).toBeNull();
  });

  it('setQueryCache resolves without throwing', async () => {
    await expect(setQueryCache('qc:_:c:abc', { rows: [1, 2] }, 'u1')).resolves.toBeUndefined();
  });

  it('invalidateUserQueryCache / invalidateQueryCache resolve without throwing', async () => {
    await expect(invalidateUserQueryCache('u1')).resolves.toBeUndefined();
    await expect(invalidateQueryCache('contacts', 't1')).resolves.toBeUndefined();
    await expect(invalidateQueryCache('contacts')).resolves.toBeUndefined();
  });
});

describe('query cache with injected Valkey backend', () => {
  it('round-trips a cached payload via getQueryCache', async () => {
    const redis = new QueryCacheFakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const key = buildQueryCacheKey('contacts', 'u1', '?limit=5', 'tenant-a');
    await setQueryCache(key, { rows: [{ id: 1 }] }, 'u1');
    expect(await getQueryCache(key)).toEqual({ rows: [{ id: 1 }] });
    expect(redis.sets.get('qc_keys:tenant-a:contacts')?.has(key)).toBe(true);
    expect(redis.sets.get('user:qc-keys:u1')?.has(key)).toBe(true);
  });

  it('returns null for corrupt JSON in the cache', async () => {
    const redis = new QueryCacheFakeRedis();
    redis.store.set('qc:_:c:badhash', 'not-json{');
    _setCacheForTests(redis as unknown as Redis);
    expect(await getQueryCache('qc:_:c:badhash')).toBeNull();
  });

  it('skips caching oversized payloads', async () => {
    const redis = new QueryCacheFakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const key = buildQueryCacheKey('big', 'u1', '?all=1', null);
    const huge = { rows: 'x'.repeat(600 * 1024) };
    await setQueryCache(key, huge, 'u1');
    expect(redis.store.has(key)).toBe(false);
  });

  it('invalidateUserQueryCache drops indexed keys', async () => {
    const redis = new QueryCacheFakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const key = buildQueryCacheKey('orders', 'u9', '?q=1', 't1');
    await setQueryCache(key, { rows: [] }, 'u9');
    await invalidateUserQueryCache('u9');
    expect(redis.store.has(key)).toBe(false);
  });

  it('invalidateQueryCache scopes to tenant + collection', async () => {
    const redis = new QueryCacheFakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const k1 = buildQueryCacheKey('items', 'u1', '?a=1', 'tenant-x');
    const k2 = buildQueryCacheKey('items', 'u1', '?a=1', 'tenant-y');
    await setQueryCache(k1, { rows: [1] }, 'u1');
    await setQueryCache(k2, { rows: [2] }, 'u1');
    await invalidateQueryCache('items', 'tenant-x');
    expect(redis.store.has(k1)).toBe(false);
    expect(redis.store.has(k2)).toBe(true);
  });

  it('invalidateQueryCacheForCollection scans all tenant index sets', async () => {
    const redis = new QueryCacheFakeRedis();
    _setCacheForTests(redis as unknown as Redis);
    const k1 = buildQueryCacheKey('shared', 'u1', '?x=1', 't-a');
    const k2 = buildQueryCacheKey('shared', 'u2', '?x=1', 't-b');
    await setQueryCache(k1, { rows: [1] }, 'u1');
    await setQueryCache(k2, { rows: [2] }, 'u2');
    await invalidateQueryCacheForCollection('shared');
    expect(redis.store.has(k1)).toBe(false);
    expect(redis.store.has(k2)).toBe(false);
  });
});
