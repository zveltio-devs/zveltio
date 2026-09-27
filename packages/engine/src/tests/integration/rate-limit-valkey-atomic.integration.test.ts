/**
 * The sliding-window buckets against a live Valkey, over eight connections, as
 * replicas sharing one Valkey reach it.
 *
 * The tenant bucket counted in one round trip and removed a refused entry in a
 * second. A request that arrived in between, after a slot had freed, still saw
 * the refused entry and was refused too. One script now makes the step atomic;
 * the gap test holds the second round trip open to land a request in it.
 *
 * Skipped without TEST_VALKEY_URL / VALKEY_URL.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import Redis from 'ioredis';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { rateLimit } from '../../middleware/rate-limit.js';

const VALKEY = process.env.TEST_VALKEY_URL ?? process.env.VALKEY_URL;
const TENANT = '33333333-3333-4333-8333-333333333333';

/** Config source: compiled tier default; a tenant limit of `tenantMax`, or none. */
function fakeDb(tier: string, tenantMax: number | null) {
  const q = {
    select: () => q,
    where: () => q,
    executeTakeFirst: async () => undefined,
    execute: async () =>
      tenantMax === null
        ? []
        : [{ key_prefix: `tenant:${tier}`, window_ms: 60_000, max_requests: tenantMax }],
  };
  return { selectFrom: () => q } as never;
}

describe.skipIf(!VALKEY)('rate-limit buckets on a live Valkey', () => {
  const clients: Redis[] = [];
  const tiers: string[] = [];
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;

  /** The next ZREM waits for it: the gap between two round trips, held open. */
  let gate: Promise<void> | null = null;
  let reachedZrem = () => {};

  beforeAll(async () => {
    for (let i = 0; i < 8; i++) clients.push(new Redis(VALKEY as string));
    let next = 0;
    // Every call on the next connection, as replicas sharing one Valkey would.
    const replicas = new Proxy({} as Redis, {
      get(_t, prop) {
        const client = clients[next++ % clients.length] as Redis;
        if (prop === 'zrem') {
          return async (...args: Parameters<Redis['zrem']>) => {
            reachedZrem();
            const held = gate;
            gate = null;
            if (held) await held;
            return client.zrem(...args);
          };
        }
        const v = (client as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === 'function' ? v.bind(client) : v;
      },
    });
    _setCacheForTests(replicas);
    savedEnv = process.env.NODE_ENV;
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY = 'true';
  });

  afterAll(async () => {
    _setCacheForTests(null);
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    const c = clients[0] as Redis;
    for (const tier of tiers) {
      const keys = await c.keys(`rl:*${tier}*`);
      if (keys.length) await c.del(...keys);
    }
    await Promise.all(clients.map((cl) => cl.quit()));
  });

  function limited(userMax: number, tenantMax: number | null) {
    const tier = `live-${crypto.randomUUID()}`;
    tiers.push(tier);
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('prefetchedSession', { user: { id: c.req.header('x-user') as string } });
      c.set('tenant', { id: TENANT } as never);
      await next();
    });
    app.use(
      '*',
      rateLimit({ keyPrefix: tier, max: userMax, windowMs: 60_000, db: fakeDb(tier, tenantMax) }),
    );
    app.get('/p', (c) => c.text('ok'));
    const one = (user: string) =>
      app.request('/p', { headers: { 'x-user': user, 'x-real-ip': '192.0.2.1' } });
    const burst = async (n: number, user: (i: number) => string) =>
      (await Promise.all(Array.from({ length: n }, (_, i) => one(user(i))))).map((r) => r.status);
    return { tier, one, burst };
  }

  it('the tenant bucket admits exactly max from many connections at once', async () => {
    const { tier, burst } = limited(1000, 25);
    const seen = await burst(120, (i) => `u${i}`);
    expect(seen.filter((s) => s === 200)).toHaveLength(25);
    // Only admitted requests are kept.
    expect(await (clients[0] as Redis).zcard(`rl:${tier}:t:${TENANT}`)).toBe(25);
  });

  it('a request in the gap after a refusal gets the slot that freed', async () => {
    const { one } = limited(1000, 2);
    const t0 = Date.now();
    let offset = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    let open = () => {};
    gate = new Promise((r) => {
      open = r;
    });
    const zrem = new Promise<void>((r) => {
      reachedZrem = r;
    });
    try {
      expect((await one('a')).status).toBe(200);
      offset = 1_000;
      expect((await one('b')).status).toBe(200);
      // Full. R is refused, and whatever follows its count is held.
      offset = 30_000;
      const refused = one('r');
      await Promise.race([zrem, refused]);
      // a's entry (t=0) has left the window: one slot is free, and S takes it.
      offset = 60_500;
      expect((await one('s')).status).toBe(200);
      open();
      expect((await refused).status).toBe(429);
    } finally {
      open();
      gate = null;
      clock.mockRestore();
    }
  });

  it('the per-user bucket admits exactly max from many connections at once', async () => {
    const { burst } = limited(25, null);
    const seen = await burst(120, () => 'one');
    expect(seen.filter((s) => s === 200)).toHaveLength(25);
  });

  it('Retry-After is when the oldest tenant entry leaves the window', async () => {
    const { one } = limited(1000, 2);
    const t0 = Date.now();
    let offset = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    try {
      expect((await one('a')).status).toBe(200);
      offset = 15_000;
      expect((await one('b')).status).toBe(200);
      offset = 20_000;
      const refused = await one('c');
      expect(refused.status).toBe(429);
      // The t=0 entry leaves at t=60, not a full window from now.
      expect(refused.headers.get('retry-after')).toBe('40');
    } finally {
      clock.mockRestore();
    }
  });
});
