import type { Context, Next } from 'hono';
import { getCache } from '../lib/runtime/index.js';
import type { Database } from '../db/index.js';

// In-process cache for DB-loaded rate limit configs (TTL: 60s)
interface ConfigEntry {
  windowMs: number;
  max: number;
  ts: number;
}
const configCache = new Map<string, ConfigEntry>();
const CONFIG_TTL = 60_000;

async function loadConfig(
  db: Database | undefined,
  keyPrefix: string,
): Promise<{ windowMs: number; max: number } | null> {
  if (!db) return null;
  const now = Date.now();
  const cached = configCache.get(keyPrefix);
  if (cached && now - cached.ts < CONFIG_TTL) return { windowMs: cached.windowMs, max: cached.max };
  try {
    const row = await db
      .selectFrom('zv_rate_limit_configs')
      .select(['window_ms', 'max_requests'])
      .where('key_prefix', '=', keyPrefix)
      .where('is_active', '=', true)
      .executeTakeFirst();
    if (row) {
      configCache.set(keyPrefix, { windowMs: row.window_ms, max: row.max_requests, ts: now });
      return { windowMs: row.window_ms, max: row.max_requests };
    }
  } catch {
    /* DB not ready yet — use defaults */
  }
  return null;
}

export function invalidateRateLimitCache(keyPrefix?: string) {
  if (keyPrefix) configCache.delete(keyPrefix);
  else configCache.clear();
}

// Module-level DB reference — set once at engine startup via initRateLimitDb()
let _db: Database | undefined;
export function initRateLimitDb(db: Database) {
  _db = db;
}

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
  if (now - lastCleanup > CLEANUP_INTERVAL || memoryStore.size > MAX_STORE_SIZE) {
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

// ── Adaptive escalation + IP lists (TECHNICAL-GAPS 2.5) ──────────────────────
//
// SAFETY PROPERTY: everything below only runs for a request that has ALREADY
// exceeded its tier limit (or is on an explicit IP list). Compliant traffic never
// reaches the escalation path, so a bug here cannot throttle legitimate users —
// worst case it mis-sizes a cooldown for someone already being 429'd.

/** Offence memory: how long repeat offences keep escalating. */
const PENALTY_WINDOW_MS = 10 * 60_000;
/** Cap so a wrong/rotated identifier can never be locked out forever. */
const MAX_BLOCK_SEC = 3600;

/**
 * Escalating cooldown for a repeat offender: 1×, 2×, 4×, 8× the tier window,
 * capped. A plain fixed window lets an abuser retry the instant it rolls over;
 * this makes each successive burst cost more, which is the "slow down abusers"
 * ask — without tarpitting (holding sockets open would DoS *us*).
 */
export function escalationSeconds(offences: number, windowSec: number): number {
  const n = Math.max(1, Math.floor(offences));
  const factor = 2 ** Math.min(n - 1, 10); // clamp the exponent before it overflows
  return Math.min(windowSec * factor, MAX_BLOCK_SEC);
}

type Cidr = { base: number; mask: number };

/** Parse a comma-separated IPv4 / CIDR list. Invalid entries are dropped. */
export function parseCidrList(raw: string | undefined): Cidr[] {
  if (!raw) return [];
  const out: Cidr[] = [];
  for (const partRaw of raw.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const [addr, bitsRaw] = part.split('/');
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const octets = (addr ?? '').split('.');
    if (octets.length !== 4) continue;
    let base = 0;
    let ok = true;
    for (const o of octets) {
      const n = Number(o);
      if (!Number.isInteger(n) || n < 0 || n > 255 || o === '') {
        ok = false;
        break;
      }
      base = (base << 8) | n;
    }
    if (!ok) continue;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    // Mask FIRST, then unsign. `(base >>> 0) & mask` looks equivalent but is not:
    // JS `&` coerces back to int32, so any address with the high bit set
    // (≥ 128.0.0.0 — i.e. most real IPs) would store a NEGATIVE base and never
    // match ipMatches(), which compares against an unsigned value.
    out.push({ base: (base & mask) >>> 0, mask });
  }
  return out;
}

/** Is `ip` inside any of the parsed CIDRs? IPv6 is never matched (returns false). */
export function ipMatches(ip: string, list: Cidr[]): boolean {
  if (list.length === 0) return false;
  const octets = ip.split('.');
  if (octets.length !== 4) return false; // IPv6 / 'unknown' — no match, no crash
  let v = 0;
  for (const o of octets) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    v = (v << 8) | n;
  }
  v = v >>> 0;
  return list.some((c) => (v & c.mask) >>> 0 === c.base);
}

// Env lists are parsed once per process — they're deployment config, not per-request.
let _allowList: Cidr[] | null = null;
let _denyList: Cidr[] | null = null;
function allowList(): Cidr[] {
  if (_allowList === null) _allowList = parseCidrList(process.env.RATE_LIMIT_ALLOWLIST);
  return _allowList;
}
function denyList(): Cidr[] {
  if (_denyList === null) _denyList = parseCidrList(process.env.RATE_LIMIT_DENYLIST);
  return _denyList;
}
/** Test seam — env lists are cached per process. */
export function resetIpListsForTests(): void {
  _allowList = null;
  _denyList = null;
}

/**
 * Normalise a peer address to a bare IPv4 when it is an IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`), which is what Bun reports for IPv4 clients. Without this
 * the CIDR lists never match and every mapped client gets its own odd bucket key.
 */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  return m ? m[1] : s;
}

interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
  db?: Database;
}

// One-shot warning per process if a deployment looks like it's behind a
// proxy (forwarded headers present) but TRUSTED_PROXY isn't set. Without
// the env var, the middleware ignores the forwarded IP and every client
// behind that proxy shares the same rate-limit bucket — which means one
// abusive client can DoS everyone else, or one well-behaved client gets
// blocked because another behind the same proxy is hammering.
let _proxyHintWarned = false;
function maybeWarnProxyMisconfig(c: Context): void {
  if (_proxyHintWarned) return;
  if (process.env.TRUSTED_PROXY === 'true') return;
  const hasFwd = !!(
    c.req.header('x-forwarded-for') ||
    c.req.header('x-real-ip') ||
    c.req.header('forwarded')
  );
  if (!hasFwd) return;
  _proxyHintWarned = true;
  console.warn(
    '[rate-limit] X-Forwarded-For/X-Real-IP detected but TRUSTED_PROXY ' +
      'is not set — all clients behind the proxy share the same rate-limit ' +
      'bucket. Set TRUSTED_PROXY=true ONLY if your edge/proxy strips ' +
      'inbound X-Forwarded-For headers before re-setting them, otherwise ' +
      'clients can spoof their IP.',
  );
}

/**
 * Client IP, honouring proxy headers ONLY behind TRUSTED_PROXY (otherwise any
 * client could spoof its identity and dodge the limit). Extracted so the IP
 * allow/deny lists can be consulted before any cache work.
 */
function resolveClientIp(c: Context): string {
  maybeWarnProxyMisconfig(c);
  const trustedProxy = process.env.TRUSTED_PROXY === 'true';
  const rawForwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  // Strict octets: a looser \d{1,3} would accept 999.999.999.999 and waste
  // rate-limit slots on bogus identifiers.
  const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$/;
  const IPV6_RE = /^[0-9a-f:]{2,39}$/i;
  const forwardedIp =
    trustedProxy &&
    rawForwardedFor &&
    (IPV4_RE.test(rawForwardedFor) || IPV6_RE.test(rawForwardedFor))
      ? rawForwardedFor
      : null;
  const realIp = trustedProxy ? (c.req.header('x-real-ip') ?? null) : null;
  // Last resort: the TCP peer. Without it, ALL unauthenticated non-proxied
  // traffic collapses onto one `rl:<tier>:unknown` bucket — so a single abusive
  // client can 429 every other anonymous client (a login DoS on /api/auth/*).
  //
  // Bun hands `{ server }` to fetch (see Bun.serve in index.ts) and exposes the
  // peer via `server.requestIP(req)`. The previous `env.ip` / `env.incoming`
  // reads are Node-adapter shapes and were ALWAYS undefined here, so this
  // protection silently did nothing. Node shape kept as a fallback.
  // biome-ignore lint/suspicious/noExplicitAny: hono env is adapter-specific
  const env = c.env as any;
  const connectionIp: string | undefined =
    normalizeIp(env?.server?.requestIP?.(c.req.raw)?.address) ??
    normalizeIp(env?.incoming?.socket?.remoteAddress);
  return forwardedIp || realIp || connectionIp || 'unknown';
}

export function rateLimit(config: RateLimitConfig) {
  const { keyPrefix, message = 'Too Many Requests', db } = config;

  return async (c: Context, next: Next) => {
    // Resolve live limits from DB (falls back to compiled defaults)
    // Per-API-key override: if request uses API key auth, check apikey:<id> prefix first
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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

    // Operator IP lists (RATE_LIMIT_DENYLIST / RATE_LIMIT_ALLOWLIST, CIDR or bare
    // IPv4, comma-separated). Deny wins — an explicitly blocked source shouldn't
    // get to spend a cache round-trip. Allow exists for known-good infra
    // (monitoring, an internal gateway) that would otherwise trip shared limits.
    const listedIp = resolveClientIp(c);
    if (ipMatches(listedIp, denyList())) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (ipMatches(listedIp, allowList())) return next();

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
      const userId: string | undefined = session?.id;
      const ip = resolveClientIp(c);
      const identifier = userId ?? ip;

      const key = `rl:${keyPrefix}:${identifier}`;
      const blockKey = `rl:block:${keyPrefix}:${identifier}`;
      const penaltyKey = `rl:pen:${keyPrefix}:${identifier}`;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Already serving a cooldown? Short-circuit before touching the window —
      // an abuser in penalty shouldn't cost us a pipeline per request.
      const blockTtl = await cache.ttl(blockKey);
      if (blockTtl > 0) {
        c.header('Retry-After', String(blockTtl));
        return c.json({ error: message }, 429);
      }

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
        // Over the limit → record the offence and escalate the cooldown. Repeat
        // bursts cost progressively more; a first-time offender just waits out
        // the normal window. Best-effort: if the penalty bookkeeping fails we
        // still deny with the plain window rather than letting the request past.
        let retryAfter = windowSec;
        try {
          const offences = await cache.incr(penaltyKey);
          if (offences === 1) await cache.pexpire(penaltyKey, PENALTY_WINDOW_MS);
          retryAfter = escalationSeconds(offences, windowSec);
          if (offences > 1) await cache.set(blockKey, '1', 'EX', retryAfter);
        } catch {
          /* keep the plain window */
        }
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: message }, 429);
      }
    } catch {
      // Valkey error — fall back to in-memory limiter instead of failing open.
      // Failing open here would disable ALL rate limits on Valkey outage,
      // allowing brute-force on /api/auth/sign-in and flooding AI endpoints.
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  message: 'Too Many Destructive Requests — DELETE operations are limited to 10 per minute',
});
