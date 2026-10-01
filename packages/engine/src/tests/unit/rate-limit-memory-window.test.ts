/**
 * The in-memory limiter (no Valkey, or Valkey down) keeps each bucket for ITS
 * window, whichever tier happens to run the periodic sweep.
 *
 * The sweep deleted every entry older than the CALLING tier's window. Every
 * compiled tier is 60 s, but a window is configurable — `zv_rate_limit_configs`
 * rows and per-tenant limits set their own — so a 15-minute bucket was dropped
 * by the next 60-second request after a minute, and a refused caller got a
 * fresh allowance long before its window ended.
 */

import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { rateLimit, rateLimitIpBucket } from '../../middleware/rate-limit.js';

function ctxForIp(ip: string): unknown {
  return {
    req: { header: (name: string) => (name.toLowerCase() === 'x-real-ip' ? ip : undefined) },
    header: () => {},
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    get: () => undefined,
  };
}

describe('in-memory rate limit sweep', () => {
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;

  beforeAll(() => {
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.TRUSTED_PROXY = 'true';
    // Under NODE_ENV=test `rateLimit` calls next() before limiting anything.
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    _setCacheForTests(null);
  });

  afterAll(() => {
    setSystemTime();
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    process.env.NODE_ENV = savedEnv;
  });

  it('a short-window tier sweeping does not reset a long-window bucket', async () => {
    const long = rateLimit({ windowMs: 15 * 60_000, max: 2, keyPrefix: 'rlmw-long' });
    const short = rateLimit({ windowMs: 1_000, max: 100, keyPrefix: 'rlmw-short' });
    const next = async () => 'next';
    const call = (mw: typeof long, ip: string): Promise<unknown> =>
      mw(ctxForIp(ip) as never, next as never);

    // Start past the sweep interval, from whenever the module was loaded.
    const t0 = Date.now() + 5 * 60_000;
    setSystemTime(new Date(t0));
    expect(await call(long, '203.0.113.7')).toBe('next');
    expect(await call(long, '203.0.113.7')).toBe('next');
    expect(((await call(long, '203.0.113.7')) as { status: number }).status).toBe(429);

    // 90 s later — past the sweep interval, well inside the 15-minute window.
    setSystemTime(new Date(t0 + 90_000));
    expect(await call(short, '198.51.100.1')).toBe('next'); // runs the sweep
    expect(((await call(long, '203.0.113.7')) as { status: number }).status).toBe(429);

    // A bucket whose own window has passed starts over. The last sweep ran at
    // t0 + 90 s, so none runs below: this is the per-key reset, not the sweep.
    const once = rateLimit({ windowMs: 1_000, max: 1, keyPrefix: 'rlmw-once' });
    expect(await call(once, '198.51.100.3')).toBe('next');
    expect(((await call(once, '198.51.100.3')) as { status: number }).status).toBe(429);
    setSystemTime(new Date(t0 + 92_000));
    expect(await call(once, '198.51.100.3')).toBe('next');
  });

  it('counts an IPv6 client by its /64, not by each address in it', async () => {
    setSystemTime();
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'rlmw-v6' });
    const next = async () => 'next';
    const call = (ip: string): Promise<unknown> => mw(ctxForIp(ip) as never, next as never);

    // Three addresses, one subscriber: the third request is the third in the bucket.
    expect(await call('2001:db8:aa:1::1')).toBe('next');
    expect(await call('2001:db8:aa:1::2')).toBe('next');
    expect(((await call('2001:db8:aa:1:ffff:ffff:ffff:ffff')) as { status: number }).status).toBe(
      429,
    );
    // The next /64 is someone else.
    expect(await call('2001:db8:aa:2::1')).toBe('next');
  });
});

describe('rateLimitIpBucket', () => {
  it('keeps IPv4 as is and reduces IPv6 to its /64 whatever the spelling', () => {
    expect(rateLimitIpBucket('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitIpBucket('2001:0DB8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIpBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(rateLimitIpBucket('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves what is not an IPv6 address alone', () => {
    for (const s of ['unknown', 'garbage:zz::1', '1:2:3:4:5:6:7:8:9', '1::2::3']) {
      expect(rateLimitIpBucket(s)).toBe(s);
    }
  });
});
