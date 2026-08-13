import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { rateLimit } from '../../middleware/rate-limit.js';

/**
 * SEC-09 calls a rate-limit middleware from inside a handler rather than
 * mounting it on the route, because whether the request is anonymous is only
 * known after the session and API-key checks have both come back empty:
 *
 *   const limited = await publicEdgeInvokeRateLimit(c, async () => undefined);
 *   if (limited) return limited;
 *
 * That reads the middleware's return value as "a Response means blocked". If
 * the pass path returned anything truthy instead, the guard would reject EVERY
 * anonymous invocation — turning a rate limit into an outage, and one that only
 * appears on the public endpoints nobody is logged into. So the assumption gets
 * a test rather than a comment.
 */
describe('rate limit used as an in-handler guard', () => {
  // `rateLimit` returns `next()` immediately when NODE_ENV is 'test', so that
  // integration suites are not throttled by their own traffic. Left in place,
  // this suite would watch six requests sail through and conclude the guard
  // works — measuring the bypass, not the guard.
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
  });

  const guard = rateLimit({
    keyPrefix: `guard-probe-${Date.now()}`,
    max: 3,
    windowMs: 60_000,
    message: 'nope',
  });

  /** Drives the middleware the way the handler does, through a real context. */
  async function attempt(app: Hono, path = '/probe') {
    // A fixed address: the limiter keys on the client IP, and a request with no
    // address at all would put every call in one bucket by accident rather than
    // by the identity the middleware actually derives.
    return app.request(path, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
  }

  it('returns nothing while under the limit, so the handler proceeds', async () => {
    const app = new Hono();
    let reached = 0;
    app.post('/probe', async (c) => {
      const limited = await guard(c, async () => undefined);
      if (limited) return limited;
      reached++;
      return c.json({ ok: true });
    });

    for (let i = 0; i < 3; i++) {
      const res = await attempt(app);
      expect(res.status).toBe(200);
    }
    expect(reached).toBe(3);
  });

  it('returns a 429 Response once the limit is passed, and the handler body never runs', async () => {
    const app = new Hono();
    let reached = 0;
    app.post('/probe', async (c) => {
      const limited = await guard(c, async () => undefined);
      if (limited) return limited;
      reached++;
      return c.json({ ok: true });
    });

    // The three from the previous test already spent the window for this key.
    const res = await attempt(app);
    expect(res.status).toBe(429);
    expect(reached).toBe(0);
  });
});
