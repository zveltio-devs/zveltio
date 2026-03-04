import Redis from 'ioredis';

let _cache: Redis | null = null;

export function getCache(): Redis | null {
  return _cache;
}

export async function initCache(): Promise<Redis | null> {
  if (!process.env.VALKEY_URL) return null;

  _cache = new Redis(process.env.VALKEY_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  await _cache.connect();
  return _cache;
}

export async function createCacheSecondaryStorage() {
  const cache = await initCache();
  if (!cache) return null;

  return {
    get: async (key: string) => {
      const value = await cache.get(key);
      return value ? JSON.parse(value) : null;
    },
    set: async (key: string, value: any, ttl?: number) => {
      if (ttl) await cache.setex(key, ttl, JSON.stringify(value));
      else await cache.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      await cache.del(key);
    },
  };
}
