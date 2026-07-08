/**
 * Query-response cache (lib/data/query-cache.ts) — the pure cache-key builder +
 * the no-op guards when no cache backend is configured (getCache() → null when
 * VALKEY_URL is unset, which is the unit-test environment). Live Valkey hit/miss
 * behaviour is covered by the query-cache integration test.
 */

import { describe, it, expect } from 'bun:test';
import {
  buildQueryCacheKey,
  getQueryCache,
  invalidateQueryCache,
  invalidateUserQueryCache,
  setQueryCache,
} from '../../lib/data/query-cache.js';

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
