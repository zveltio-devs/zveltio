// ioredis connects to Valkey (Redis-compatible, open-source).
// Valkey was chosen over Redis after Redis's BSL license change (2024).
import Redis from 'ioredis';

let _cache: Redis | null = null;

/**
 * Get cache instance. Returns null if not initialized.
 * Safe to call from anywhere - will not trigger lazy initialization.
 */
export function getCache(): Redis | null {
  return _cache;
}

/**
 * Initialize cache with lazy connection. Only connects if VALKEY_URL is set.
 * Optimizations:
 * - lazyConnect: connection is established only when first command is issued
 * - noReadyCheck: skips initial INFO command for faster startup
 * - maxRetriesPerRequest: retry up to 3 times on transient failures
 */
export async function initCache(): Promise<Redis | null> {
  if (!process.env.VALKEY_URL) return null;

  _cache = new Redis(process.env.VALKEY_URL, {
    lazyConnect: true, // Connect only when first command is issued
    maxRetriesPerRequest: 3, // Retry up to 3 times on transient failures
    // Memory optimizations for Valkey client
    retryStrategy: (times: number) => {
      // Exponential backoff with jitter
      const delay =
        Math.min(100 * Math.pow(2, times), 1000) + Math.random() * 100;
      return delay;
    },
  });

  await _cache.connect();
  return _cache;
}

export async function createCacheSecondaryStorage() {
  const cache = await initCache();
  if (!cache) return null;

  /**
   * Optimized cache operations with:
   * - TTL defaults to 300s (5min) for most data to reduce memory footprint
   * - Immediate deletion instead of lazy cleanup
   * - Minimal serialization overhead
   */
  return {
    get: async (key: string, _ttl?: number) => {
      const value = await cache.get(key);
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        // Corrupted cache entry — treat as miss so DB is used instead
        return null;
      }
    },
    set: async (key: string, value: any, ttl: number = 300) => {
      // Default TTL of 300s (5min) - shorter than previous default
      // Reduces memory footprint while maintaining performance
      await cache.setex(key, ttl, JSON.stringify(value));
    },
    setnx: async (key: string, value: any, ttl: number = 300) => {
      // Set if not exists - useful for rate limiting, locks.
      // NX flag ensures the key is only written if it does not already exist.
      await cache.set(key, JSON.stringify(value), 'EX', ttl, 'NX');
    },
    delete: async (key: string) => {
      await cache.del(key);
    },
    // Pipeline support for batch operations
    pipeline: async (
      operations: Array<{
        type: 'get' | 'set' | 'del';
        key: string;
        value?: any;
        ttl?: number;
      }>,
    ) => {
      // pipeline() sends all commands in one roundtrip without transactional overhead.
      // Use cache.multi() only when you need atomic MULTI/EXEC semantics.
      const pipe = cache.pipeline();
      for (const op of operations) {
        if (op.type === 'get') {
          pipe.get(op.key);
        } else if (op.type === 'set') {
          pipe.setex(op.key, op.ttl || 300, JSON.stringify(op.value));
        } else if (op.type === 'del') {
          pipe.del(op.key);
        }
      }
      const results = await pipe.exec();
      if (!results) return [];
      return results.map((r: any) => (r[0] ? null : r[1]));
    },
  };
}
