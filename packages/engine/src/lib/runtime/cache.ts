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
 * Strip credentials from a Valkey URL so it can be logged.
 *
 * The URL is the single most useful thing to print when a connection fails —
 * host, port and database are usually where the mistake is — and it is also the
 * one place a password may sit. So print it, without that.
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    if (u.username) u.username = '***';
    return u.toString();
  } catch {
    // Not a parseable URL — that is itself the likely fault, and echoing the
    // raw string back is what tells the operator so. It cannot contain a
    // password in a form we could have parsed out anyway.
    return url;
  }
}

/**
 * Initialize cache with lazy connection. Only connects if VALKEY_URL is set.
 * Optimizations:
 * - lazyConnect: connection is established only when first command is issued
 * - noReadyCheck: skips initial INFO command for faster startup
 * - maxRetriesPerRequest: retry up to 3 times on transient failures
 *
 * Returning null is for tests and for the operator who set
 * `ZVELTIO_ALLOW_NO_CACHE=1`; a production boot without `VALKEY_URL` is stopped
 * earlier, by `productionGuardViolations`. That guard covers the variable being
 * ABSENT. This function covers it being PRESENT AND WRONG, which is now the
 * likelier mistake of the two — see the error it throws.
 */
export async function initCache(): Promise<Redis | null> {
  if (!process.env.VALKEY_URL) return null;

  _cache = new Redis(process.env.VALKEY_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => {
      const delay = Math.min(100 * 2 ** times, 1000) + Math.random() * 100;
      return delay;
    },
  });

  // ioredis reports the REASON on the 'error' event and then rejects
  // `connect()` with a generic "Connection is closed." — two separate places,
  // and only the useless one is thrown. Wrong password printed
  // "NOAUTH Authentication required." to the log and then failed the boot with
  // an ioredis stack trace, so the message naming the actual fault was several
  // lines above the one that stopped the engine, and looked unrelated to it.
  //
  // Keep the last reason so it can be attached below. An array rather than a
  // `let`: assigned only inside a callback, a `let` narrows to `never` by the
  // catch block and will not compile.
  const seen: Error[] = [];
  _cache.on('error', (err: Error) => {
    seen.push(err);
    console.error('[cache] Valkey error:', err.message);
  });

  try {
    await _cache.connect();
  } catch (err) {
    // Trailing period trimmed: ioredis ends some messages with one and not
    // others, and the sentence below supplies its own.
    const raw = seen.at(-1)?.message ?? (err instanceof Error ? err.message : String(err));
    const reason = raw.replace(/\.\s*$/, '');
    const hint = /NOAUTH|WRONGPASS/i.test(reason)
      ? ' The server wants a password: put it in the URL as redis://:PASSWORD@host:port.'
      : /ECONNREFUSED/i.test(reason)
        ? ' Nothing is listening there — check that Valkey is running and on that port.'
        : '';
    throw new Error(
      `Cannot connect to Valkey at ${redactUrl(process.env.VALKEY_URL)}: ${reason}.${hint} ` +
        'Valkey is required: permission and identity caches, rate limiting and webhook ' +
        'delivery all depend on it. To boot without one, and accept what that costs, set ' +
        'ZVELTIO_ALLOW_NO_CACHE=1 and unset VALKEY_URL.',
      { cause: err },
    );
  }
  return _cache;
}

/**
 * Test-only: inject (or clear) the cache singleton so cache-backed modules
 * (webhook-worker, rate-limiter, query-cache) can be unit-tested against a fake
 * Redis without a live Valkey. Pass null to reset.
 */
export function _setCacheForTests(cache: Redis | null): void {
  _cache = cache;
}

export async function createCacheSecondaryStorage() {
  const cache = getCache() ?? (await initCache());
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
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    set: async (key: string, value: any, ttl: number = 300) => {
      // Default TTL of 300s (5min) - shorter than previous default
      // Reduces memory footprint while maintaining performance
      await cache.setex(key, ttl, JSON.stringify(value));
    },
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      return results.map((r: any) => (r[0] ? null : r[1]));
    },
  };
}
