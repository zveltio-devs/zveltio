import type { Context, Next } from 'hono';
import { getCache } from '../lib/cache.js';

interface RateLimitConfig {
  windowMs: number;   // sliding window size in ms
  max: number;        // max requests per window
  keyPrefix: string;  // e.g. 'api', 'auth', 'ai'
  message?: string;
}

export function rateLimit(config: RateLimitConfig) {
  const { windowMs, max, keyPrefix, message = 'Too Many Requests' } = config;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (c: Context, next: Next) => {
    const cache = getCache();

    // If Redis is unavailable — fail open to preserve availability
    if (!cache) return next();

    try {
      // Identifier: authenticated userId or client IP
      const session = (c as any).get?.('user');
      const userId: string | undefined = session?.id;
      const ip =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        c.req.header('x-real-ip') ||
        'unknown';
      const identifier = userId ?? ip;

      const key = `rl:${keyPrefix}:${identifier}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Sliding window using a sorted set:
      // - ZREMRANGEBYSCORE removes entries outside the window
      // - ZADD adds current request timestamp
      // - ZCARD counts requests in window
      // All in a single pipeline for atomicity
      const pipeline = cache.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.zcard(key);
      pipeline.pexpire(key, windowMs);
      const results = await pipeline.exec();

      const count = (results?.[2]?.[1] as number) ?? 0;
      const resetAt = Math.ceil((now + windowMs) / 1000);

      c.header('X-RateLimit-Limit', String(max));
      c.header('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      c.header('X-RateLimit-Reset', String(resetAt));

      if (count > max) {
        c.header('Retry-After', String(windowSec));
        return c.json({ error: message }, 429);
      }
    } catch {
      // Redis error — fail open
    }

    return next();
  };
}

export const authRateLimit = rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'auth' });
export const apiRateLimit  = rateLimit({ windowMs: 60_000, max: 200, keyPrefix: 'api' });
export const aiRateLimit   = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'ai' });
