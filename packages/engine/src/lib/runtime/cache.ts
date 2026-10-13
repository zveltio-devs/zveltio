// ioredis connects to Valkey (Redis-compatible, open-source).
// Valkey was chosen over Redis after Redis's BSL license change (2024).
import type { SecondaryStorage } from 'better-auth';
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
 * `ZVELTIO_SINGLE_INSTANCE=1`; a production boot without `VALKEY_URL` is stopped
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
        'delivery all depend on it. To run exactly one instance without it, set ' +
        'ZVELTIO_SINGLE_INSTANCE=1 and unset VALKEY_URL.',
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

  const parse = (value: string | null) => {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      // Corrupted cache entry — treat as miss so DB is used instead
      return null;
    }
  };

  const storage = {
    get: async (key: string, _ttl?: number) => parse(await cache.get(key)),
    /**
     * Better-Auth consumes every single-use value through this: password-reset
     * tokens, magic links, email/phone OTPs, two-factor OTPs, one-time tokens,
     * email-change links. Since 1.7 it is a required member of SecondaryStorage
     * and is called unguarded, so without it each of those flows threw
     * "secondaryStorage.getAndDelete is not a function" on every install with
     * Valkey — which, since #402, is every production install.
     *
     * One GETDEL, not GET then DEL: two requests redeeming the same token
     * together must not both read it before either deletes it.
     */
    getAndDelete: async (key: string) => parse(await cache.getdel(key)),
    // No ttl means no expiry, as Better-Auth's interface reads: a default here
    // would quietly expire whatever it stored without one.
    set: async (key: string, value: unknown, ttl?: number) => {
      if (ttl) await cache.setex(key, ttl, JSON.stringify(value));
      else await cache.set(key, JSON.stringify(value));
    },
    delete: async (key: string) => {
      await cache.del(key);
    },
    /**
     * Better-Auth's rate limiter requires this, and refuses to serve without it.
     *
     * Once a secondary storage exists, Better-Auth routes rate limiting through
     * it rather than memory, and asserts the method up front:
     *
     *     BetterAuthError: Secondary-storage rate limiting requires
     *                      SecondaryStorage.increment.
     *
     * That is a 500 on `/api/auth/*` — sign-in included — so authentication is
     * simply down. Two conditions have to meet for it: Valkey configured (which
     * builds this object) and rate limiting on (which Better-Auth does by
     * default only when NODE_ENV=production). Since #402 made Valkey required,
     * the first is now true of every production install.
     *
     * No test caught it because the whole harness runs NODE_ENV=test, where the
     * rate limiter never starts. It surfaced in the extensions repo's live probe
     * — the one job that boots in production mode — and only after that job was
     * given a Valkey, which it had been missing.
     *
     * INCR + EXPIRE, not read-modify-write: two requests arriving together must
     * not both read 4 and both write 5. `INCR` is atomic, and the TTL is set only
     * on the first increment so the window starts when the first request in it
     * does — refreshing it on every hit would let a steady stream hold the window
     * open forever.
     */
    increment: async (key: string, ttl: number = 60) => {
      const n = await cache.incr(key);
      if (n === 1) await cache.expire(key, ttl);
      return n;
    },
  };
  // A member Better-Auth adds to the interface must fail typecheck here, not
  // production: auth.ts hands this object over as `any`, so nothing else checks.
  return storage satisfies SecondaryStorage;
}
