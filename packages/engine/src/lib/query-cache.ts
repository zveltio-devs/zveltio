/**
 * Transparent query result cache backed by Valkey (Redis).
 *
 * Cache keys: `qc:{tenantId}:{collection}:{hash}` where hash is a
 * deterministic fingerprint of (userId, URL). Tenant is part of the
 * KEY namespace (not just the hash input) so:
 *   1. Invalidation can be tenant-scoped (a write in tenant A doesn't
 *      churn tenant B's hot cache).
 *   2. The same userId switching between tenants via X-Tenant-Slug
 *      cannot retrieve another tenant's cached response — without this
 *      the same user+URL combination across tenants collided on the
 *      same key and the second tenant would receive the first's rows.
 *
 * TTL: configurable via QUERY_CACHE_TTL_SECONDS (default: 10s).
 * Invalidation: all keys for `qc:{tenant}:{collection}` are dropped on
 * any write to that collection in that tenant.
 */

import { getCache } from './cache.js';
import { createHash } from 'crypto';

const CACHE_TTL = parseInt(process.env.QUERY_CACHE_TTL_SECONDS ?? '10', 10);
const MAX_VALUE_BYTES = 512 * 1024; // 512KB — don't cache huge responses

// Sentinel used when no tenant context is present (single-tenant mode).
// `_` is invalid in tenant slugs/uuids so there's no collision with a
// real tenant.
const NO_TENANT = '_';

function hashKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function buildQueryCacheKey(
  collection: string,
  userId: string,
  queryString: string,
  tenantId: string | null = null,
): string {
  const t = tenantId ?? NO_TENANT;
  return `qc:${t}:${collection}:${hashKey([userId, queryString])}`;
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

export async function setQueryCache(
  key: string,
  value: any,
  userId?: string | null,
): Promise<void> {
  const cache = getCache();
  if (!cache || CACHE_TTL <= 0) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_VALUE_BYTES) return; // skip oversized responses
    await cache.setex(key, CACHE_TTL, serialized);
    // Key shape: `qc:{tenant}:{collection}:{hash}` — index under the
    // tenant+collection tuple so invalidation can scope to a single
    // tenant's writes (a cross-tenant invalidate would just churn the
    // other tenants' hot caches needlessly).
    const parts = key.split(':');
    const tenant = parts[1];
    const collection = parts[2];
    const indexKey = `qc_keys:${tenant}:${collection}`;
    await cache.sadd(indexKey, key);
    await cache.expire(indexKey, CACHE_TTL + 5);
    // Also index by user (the cached rows are RLS-filtered + column-masked for
    // THIS user's role) so a role grant/revoke can drop just their entries —
    // the key hashes userId, so it can't be pattern-matched otherwise.
    if (userId) {
      const userIndex = `user:qc-keys:${userId}`;
      await cache.sadd(userIndex, key);
      await cache.expire(userIndex, CACHE_TTL + 5);
    }
  } catch {
    // Non-critical — just skip caching
  }
}

/**
 * Invalidate every cached query response computed for a user. Called when the
 * user's authorization changes (Casbin role grant/revoke, membership change) —
 * the cache holds rows already shaped by their old role, so without this a
 * viewer→admin promotion (or the reverse) is served stale for up to the TTL.
 */
export async function invalidateUserQueryCache(userId: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    const userIndex = `user:qc-keys:${userId}`;
    const keys = await cache.smembers(userIndex);
    if (keys.length > 0) await cache.del(...keys, userIndex);
    else await cache.del(userIndex);
  } catch {
    // Non-critical
  }
}

export async function invalidateQueryCache(
  collection: string,
  tenantId: string | null = null,
): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    const tenant = tenantId ?? '_';
    const setKey = `qc_keys:${tenant}:${collection}`;
    const keys = await cache.smembers(setKey);
    if (keys.length > 0) {
      await cache.del(...keys, setKey);
    }
  } catch {
    // Non-critical
  }
}

/**
 * Invalidate a collection's query cache across ALL tenants. Used when the
 * authorization that shaped the cached payload changes (RLS policy, column
 * permissions) — the cache stores already-filtered/masked rows, so without this
 * a revoke would be served stale for up to the TTL. SCAN (not KEYS) over the
 * per-tenant index sets; runs only on infrequent admin auth changes.
 */
export async function invalidateQueryCacheForCollection(collection: string): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  try {
    const pattern = `qc_keys:*:${collection}`;
    let cursor = '0';
    const setKeys: string[] = [];
    do {
      const [next, batch] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      setKeys.push(...batch);
    } while (cursor !== '0');
    for (const setKey of setKeys) {
      const members = await cache.smembers(setKey);
      await cache.del(...members, setKey).catch(() => {});
    }
  } catch {
    // Non-critical
  }
}
