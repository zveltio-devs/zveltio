/**
 * Transparent query result cache backed by Valkey (Redis).
 *
 * Cache keys: `qc:{collection}:{hash}` where hash is a deterministic
 * fingerprint of the request (user, query params).
 * TTL: configurable via QUERY_CACHE_TTL_SECONDS (default: 10s).
 * Invalidation: all keys for a collection are invalidated on any write.
 */

import { getCache } from './cache.js';
import { createHash } from 'crypto';

const CACHE_TTL = parseInt(process.env.QUERY_CACHE_TTL_SECONDS ?? '10', 10);
const MAX_VALUE_BYTES = 512 * 1024; // 512KB — don't cache huge responses

function hashKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function buildQueryCacheKey(
  collection: string,
  userId: string,
  queryString: string,
): string {
  return `qc:${collection}:${hashKey([userId, queryString])}`;
}

export async function getQueryCache(key: string): Promise<any | null> {
  const cache = getCache();
  if (!cache || CACHE_TTL <= 0) return null;
  try {
    const val = await cache.get(key);
    if (!val) return null;
    return JSON.parse(val);
  } catch {
    return null;
  }
}

export async function setQueryCache(key: string, value: any): Promise<void> {
  const cache = getCache();
  if (!cache || CACHE_TTL <= 0) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_VALUE_BYTES) return; // skip oversized responses
    await cache.setex(key, CACHE_TTL, serialized);
    // Track the key under a set for the collection so we can invalidate all at once
    const collection = key.split(':')[1];
    await cache.sadd(`qc_keys:${collection}`, key);
    await cache.expire(`qc_keys:${collection}`, CACHE_TTL + 5);
  } catch {
    // Non-critical — just skip caching
  }
}

export async function invalidateQueryCache(collection: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    const setKey = `qc_keys:${collection}`;
    const keys = await cache.smembers(setKey);
    if (keys.length > 0) {
      await cache.del(...keys, setKey);
    }
  } catch {
    // Non-critical
  }
}
