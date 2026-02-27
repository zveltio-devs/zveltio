import Redis from 'ioredis';

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  return _redis;
}

export async function initRedis(): Promise<Redis | null> {
  if (!process.env.REDIS_URL) return null;

  _redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  await _redis.connect();
  return _redis;
}

export async function createRedisSecondaryStorage() {
  const redis = await initRedis();
  if (!redis) return null;

  return {
    get: async (key: string) => {
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    },
    set: async (key: string, value: any, ttl?: number) => {
      if (ttl) await redis.setex(key, ttl, JSON.stringify(value));
      else await redis.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      await redis.del(key);
    },
  };
}
