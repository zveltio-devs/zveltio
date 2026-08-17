import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { rateLimit } from '../../middleware/rate-limit.js';

/**
 * The limiter has two fallbacks to an in-process counter: one when no cache is
 * configured, and one when Valkey throws. Both used to key anonymous callers as
 * the literal string `'unknown'`, which is a single bucket for every anonymous
 * caller in the world.
 *
 * On an authenticated API that would merely be a wrong limit. On the pre-auth
 * surfaces this protects — public form submission, share-link passwords, SCIM —
 * it inverts the fix: they are anonymous by definition, so `session?.id` is
 * always undefined, and one visitor spending the budget locks out everyone
 * else. The protection becomes the outage.
 *
 * The no-cache branch is covered by the harness test next door. This covers the
 * OUTAGE branch, the more dangerous of the two and the harder to reach: it runs
 * only when a configured Valkey fails, so an install that has a cache and
 * believes itself covered degrades into the broken behaviour mid-incident.
 */

/** A cache that is present and answers every call by throwing. */
function brokenCache(): unknown {
  const boom = () => {
    throw new Error('valkey is down');
  };
  return new Proxy({}, { get: () => boom });
}

function ctxForIp(ip: string): unknown {
  return {
    req: { header: (name: string) => (name.toLowerCase() === 'x-real-ip' ? ip : undefined) },
    header: () => {},
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    get: () => undefined,
  };
}

describe('rate limiting while Valkey is down', () => {
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;

  beforeAll(() => {
    // Without TRUSTED_PROXY the limiter ignores x-real-ip entirely — by design,
    // since an untrusted client could otherwise pick its own bucket. Omitting it
    // made both "distinct addresses" resolve to the same identifier, and the
    // test measured that instead of the fix.
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.TRUSTED_PROXY = 'true';
    // `rateLimit` returns next() immediately under NODE_ENV=test, so leaving it
    // would measure the bypass rather than the limiter.
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    _setCacheForTests(brokenCache() as never);
  });

  afterAll(() => {
    _setCacheForTests(null);
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  // The in-memory counter is process-global and keyed by prefix, so each test
  // takes a fresh prefix rather than trying to reset shared state.
  let prefixCounter = 0;
  afterEach(() => {
    prefixCounter++;
  });

  async function drain(guard: ReturnType<typeof rateLimit>, ip: string, times: number) {
    const codes: number[] = [];
    for (let i = 0; i < times; i++) {
      const res = (await guard(ctxForIp(ip) as never, async () => undefined)) as
        | { status?: number }
        | undefined;
      codes.push(res?.status ?? 200);
    }
    return codes;
  }

  it('still limits the client that is spending the budget', async () => {
    const guard = rateLimit({ windowMs: 60_000, max: 3, keyPrefix: `outage${prefixCounter}` });
    const codes = await drain(guard, '203.0.113.10', 5);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  it('does not lock out a client that has sent nothing', async () => {
    const guard = rateLimit({ windowMs: 60_000, max: 3, keyPrefix: `outage${prefixCounter}` });
    await drain(guard, '203.0.113.10', 5);

    // The whole point. Under `'unknown'` this second address inherited the
    // first one's exhausted bucket and was refused on its very first request,
    // having sent nothing at all.
    const innocent = await drain(guard, '198.51.100.20', 1);
    expect(innocent).toEqual([200]);
  });
});
