import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit } from '../../middleware/rate-limit.js';

/**
 * What the rate limiter uses as a caller's IDENTITY, and what it refuses to
 * take on the caller's word.
 *
 * X-Forwarded-For has always been pattern-checked before it is believed.
 * X-Real-IP was not: behind TRUSTED_PROXY it was read verbatim and used as the
 * bucket key, so a client sending a different junk value per request answered
 * 200 five times against a limit of two — every distinct string is its own
 * bucket. That is not a weaker limit, it is the absence of one, and it is
 * reachable wherever the edge sets X-Forwarded-For but forwards the client's
 * inbound X-Real-IP unchanged.
 */
describe('rate limit identity from proxy headers', () => {
  // The middleware returns next() immediately under NODE_ENV=test, so a suite
  // left at the default would watch everything sail through and call it a pass.
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.NODE_ENV;
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
  });

  /** A fresh limiter per case — the fallback store is module-global. */
  function probe(max: number) {
    const app = new Hono();
    app.use(
      '*',
      rateLimit({ keyPrefix: `identity-${crypto.randomUUID()}`, max, windowMs: 60_000 }),
    );
    app.get('/probe', (c) => c.text('ok'));
    return async (headers: Record<string, string>) =>
      (await app.request('/probe', { headers })).status;
  }

  it('does not let a junk X-Real-IP mint a new bucket per request', async () => {
    process.env.TRUSTED_PROXY = 'true';
    const hit = probe(2);
    const seen = [
      await hit({ 'x-real-ip': 'j1' }),
      await hit({ 'x-real-ip': 'j2' }),
      await hit({ 'x-real-ip': 'j3' }),
      await hit({ 'x-real-ip': 'j4' }),
    ];
    // None of those are IP addresses, so all four are the same anonymous caller
    // and the limit of two applies across them.
    expect(seen).toEqual([200, 200, 429, 429]);
  });

  it('still honours a well-formed X-Real-IP as the identity', async () => {
    process.env.TRUSTED_PROXY = 'true';
    const hit = probe(2);
    // Two real clients behind the proxy must not share one budget — the point
    // of trusting the header in the first place.
    expect(await hit({ 'x-real-ip': '198.51.100.4' })).toBe(200);
    expect(await hit({ 'x-real-ip': '198.51.100.4' })).toBe(200);
    expect(await hit({ 'x-real-ip': '198.51.100.4' })).toBe(429);
    expect(await hit({ 'x-real-ip': '198.51.100.9' })).toBe(200);
    expect(await hit({ 'x-real-ip': '2001:db8::1' })).toBe(200);
  });

  it('ignores both proxy headers entirely when TRUSTED_PROXY is not set', async () => {
    delete process.env.TRUSTED_PROXY;
    const hit = probe(2);
    // Otherwise any client could pick its own identity and never be limited.
    expect(await hit({ 'x-real-ip': '198.51.100.4' })).toBe(200);
    expect(await hit({ 'x-forwarded-for': '203.0.113.7' })).toBe(200);
    expect(await hit({ 'x-real-ip': '198.51.100.5' })).toBe(429);
  });

  it('keeps a live counter after the store passes the old 5_000 trigger', async () => {
    process.env.TRUSTED_PROXY = 'true';
    const hit = probe(2);
    expect(await hit({ 'x-real-ip': '203.0.113.1' })).toBe(200);

    // Fill the shared fallback store past the size that used to force a full
    // sweep on every request. The sweep drops expired entries only; a hard cap
    // added later would have to evict a live one, which is what this pins.
    const flood = probe(1_000_000);
    for (let i = 0; i < 6_000; i++) {
      await flood({ 'x-real-ip': `10.${(i >> 16) & 0xff}.${(i >> 8) & 0xff}.${i & 0xff}` });
    }

    expect(await hit({ 'x-real-ip': '203.0.113.1' })).toBe(200);
    expect(await hit({ 'x-real-ip': '203.0.113.1' })).toBe(429);
  }, 60_000);
});
