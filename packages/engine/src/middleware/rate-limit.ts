import type { Context, Next } from 'hono';
import { getCache } from '../lib/cache.js';
import type { Database } from '../db/index.js';

// In-process cache for DB-loaded rate limit configs (TTL: 60s)
interface ConfigEntry { windowMs: number; max: number; ts: number }
const configCache = new Map<string, ConfigEntry>();
const CONFIG_TTL = 60_000;

async function loadConfig(db: Database | undefined, keyPrefix: string): Promise<{ windowMs: number; max: number } | null> {
  if (!db) return null;
  const now = Date.now();
  const cached = configCache.get(keyPrefix);
  if (cached && now - cached.ts < CONFIG_TTL) return { windowMs: cached.windowMs, max: cached.max };
  try {
    const row = await (db as any)
      .selectFrom('zv_rate_limit_configs')
      .select(['window_ms', 'max_requests'])
      .where('key_prefix', '=', keyPrefix)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (row) {
      configCache.set(keyPrefix, { windowMs: row.window_ms, max: row.max_requests, ts: now });
      return { windowMs: row.window_ms, max: row.max_requests };
    }
  } catch { /* DB not ready yet — use defaults */ }
  return null;
}

export function invalidateRateLimitCache(keyPrefix?: string) {
  if (keyPrefix) configCache.delete(keyPrefix);
  else configCache.clear();
}

// Module-level DB reference — set once at engine startup via initRateLimitDb()
let _db: Database | undefined;
export function initRateLimitDb(db: Database) { _db = db; }

// Fallback in-memory rate limiter — active when Valkey is not available.
// Optimized sliding window: Map<identifier, { count: number, windowStart: number }>
// WARNING: does not synchronize between instances — used ONLY as a safety fallback.
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const memoryStore = new Map<string, RateLimitEntry>();
let lastCleanup = Date.now();
const CLEANUP_INTERVAL = 60_000; // Clean every minute
const MAX_STORE_SIZE = 5_000; // Reduced from 10_000 to prevent memory bloat

function memoryRateLimit(key: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;

  // Periodic cleanup to prevent memory leaks
  if (
    now - lastCleanup > CLEANUP_INTERVAL ||
    memoryStore.size > MAX_STORE_SIZE
  ) {
    lastCleanup = now;
    for (const [k, entry] of memoryStore) {
      if (entry.windowStart < windowStart) {
        memoryStore.delete(k);
      }
    }
  }

  const entry = memoryStore.get(key);

  if (!entry) {
    // New entry
    memoryStore.set(key, { count: 1, windowStart: now });
    return true;
  }

  // Check if window expired
  if (entry.windowStart < windowStart) {
    // Reset counter for new window
    memoryStore.set(key, { count: 1, windowStart: now });
    return true;
  }

  // Increment counter in current window
  entry.count++;
  return entry.count <= max;
}

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
  db?: Database;
}

export function rateLimit(config: RateLimitConfig) {
  const { keyPrefix, message = 'Too Many Requests', db } = config;

  return async (c: Context, next: Next) => {
    // Resolve live limits from DB (falls back to compiled defaults)
    // Per-API-key override: if request uses API key auth, check apikey:<id> prefix first
    const session = (c as any).get?.('user');
    const apiKeyId = session?.id?.startsWith('apikey:') ? session.id.slice(7) : null;
    const perKeyPrefix = apiKeyId ? `apikey:${apiKeyId}` : null;

    const [live, perKeyLive] = await Promise.all([
      loadConfig(db ?? _db, keyPrefix),
      perKeyPrefix ? loadConfig(db ?? _db, perKeyPrefix) : Promise.resolve(null),
    ]);

    // Per-key config takes precedence over tier config
    const windowMs = perKeyLive?.windowMs ?? live?.windowMs ?? config.windowMs;
    const max = perKeyLive?.max ?? live?.max ?? config.max;
    const windowSec = Math.ceil(windowMs / 1000);
    // Skip rate limiting in test environment to allow integration tests to run
    if (process.env.NODE_ENV === 'test') return next();

    const cache = getCache();

    // Fallback in-memory when Redis is not available — fail CLOSED for safety
    if (!cache) {
      const identifier = session?.id ?? 'unknown';
      const key = `rl:${keyPrefix}:${identifier}`;
      const allowed = memoryRateLimit(key, windowMs, max);
      if (!allowed) {
        c.header('Retry-After', String(windowSec));
        return c.json({ error: message }, 429);
      }
      return next();
    }

    try {
      // Identifier: authenticated userId or client IP.
      // x-forwarded-for is only trusted when behind a known proxy (TRUSTED_PROXY=true env var).
      // Without this guard, any client can set the header to bypass per-IP rate limiting.
      const userId: string | undefined = session?.id;

      const trustedProxy = process.env.TRUSTED_PROXY === 'true';
      const rawForwardedFor = c.req
        .header('x-forwarded-for')
        ?.split(',')[0]
        ?.trim();
      // Validate the extracted IP to be a basic IPv4/IPv6 format before trusting it
      // H4 FIX: Tighten IPv4 regex — old pattern accepted 999.999.999.999 as valid.
      // New pattern validates each octet is 0-255 strictly.
      const IPV4_RE =
        /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
      const IPV6_RE = /^[0-9a-f:]{2,39}$/i;
      const forwardedIp =
        trustedProxy &&
        rawForwardedFor &&
        (IPV4_RE.test(rawForwardedFor) || IPV6_RE.test(rawForwardedFor))
          ? rawForwardedFor
          : null;

      // x-real-ip is also a proxy-injected header — only trust it behind a trusted proxy
      const realIp = trustedProxy ? (c.req.header('x-real-ip') ?? null) : null;

      // Last-resort fallback: actual TCP connection address, available via Hono's env
      // depending on the adapter (Node.js: incoming.socket.remoteAddress, Bun: env.ip).
      // Prevents all unauthenticated non-proxied traffic from sharing the same
      // 'rl:api:unknown' rate-limit key, which would allow a single client to DoS others.
      const connectionIp: string | undefined =
        (c.env as any)?.incoming?.socket?.remoteAddress ??
        (c.env as any)?.ip ??
        undefined;

      const ip = forwardedIp || realIp || connectionIp || 'unknown';
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
      pipeline.zadd(key, now, `${now}-${crypto.randomUUID()}`);
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
      // Valkey error — fall back to in-memory limiter instead of failing open.
      // Failing open here would disable ALL rate limits on Valkey outage,
      // allowing brute-force on /api/auth/sign-in and flooding AI endpoints.
      const session = (c as any).get?.('user');
      const identifier = session?.id ?? 'unknown';
      const key = `rl:${keyPrefix}:${identifier}`;
      const allowed = memoryRateLimit(key, windowMs, max);
      if (!allowed) {
        c.header('Retry-After', String(windowSec));
        return c.json({ error: message }, 429);
      }
    }

    return next();
  };
}

export const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyPrefix: 'auth',
});
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 200,
  keyPrefix: 'api',
});
export const aiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyPrefix: 'ai',
});
export const writeRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  keyPrefix: 'write',
});
export const ddlRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyPrefix: 'ddl',
});
export const destructiveRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyPrefix: 'destructive',
  message:
    'Too Many Destructive Requests — DELETE operations are limited to 10 per minute',
});
