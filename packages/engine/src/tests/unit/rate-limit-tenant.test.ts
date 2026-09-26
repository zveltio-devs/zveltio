import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import {
  parseTenantLimitKey,
  pickTenantLimit,
  rateLimit,
  rateLimitTiers,
} from '../../middleware/rate-limit.js';

/**
 * Per-tenant limit: which config row applies, and how the tenant bucket sits
 * next to the caller's own. The end-to-end behaviour is in
 * `harness/tenant-rate-limit.test.ts`; this pins the pieces it cannot isolate —
 * the Valkey branch (the harness has no Valkey) and the order of the two checks.
 */

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

describe('parseTenantLimitKey', () => {
  it('accepts a known tier, with or without a tenant uuid', () => {
    expect(rateLimitTiers()).toContain('api');
    expect(parseTenantLimitKey('tenant:api')).toEqual({ tier: 'api', tenantId: null });
    expect(parseTenantLimitKey(`tenant:api:${T1.toUpperCase()}`)).toEqual({
      tier: 'api',
      tenantId: T1,
    });
  });

  it('refuses anything a limiter would never read', () => {
    for (const key of [
      'api',
      'tenant:',
      'tenant:nope',
      'tenant:api:not-a-uuid',
      `tenant:api:${T1}:extra`,
      `apikey:${T1}`,
      `tenants:api:${T1}`,
    ]) {
      expect(parseTenantLimitKey(key)).toBeNull();
    }
  });
});

describe('pickTenantLimit', () => {
  const row = (key_prefix: string, max_requests: number) => ({
    key_prefix,
    window_ms: 60_000,
    max_requests,
  });

  it('prefers the tenant override, then the tier default, then nothing', () => {
    const rows = [row('tenant:api', 10), row(`tenant:api:${T1}`, 50)];
    expect(pickTenantLimit(rows, 'api', T1)?.max).toBe(50);
    expect(pickTenantLimit(rows, 'api', T2)?.max).toBe(10);
    expect(pickTenantLimit([], 'api', T1)).toBeNull();
  });

  it('never applies another tenant or another tier', () => {
    expect(pickTenantLimit([row(`tenant:api:${T2}`, 5)], 'api', T1)).toBeNull();
    expect(pickTenantLimit([row('tenant:ai', 5)], 'api', T1)).toBeNull();
  });
});

/**
 * Just enough of ioredis for the limiter: a sorted set per key, and `eval` of
 * the one script the limiter runs, modelled step for step. The real script is
 * run against a live Valkey in `integration/rate-limit-valkey-atomic`.
 */
class FakeValkey {
  zsets = new Map<string, Map<string, number>>();
  zset(k: string) {
    if (!this.zsets.has(k)) this.zsets.set(k, new Map());
    return this.zsets.get(k) as Map<string, number>;
  }
  async eval(_script: string, _n: number, k: string, ...argv: Array<string | number>) {
    const [now, window, max] = argv.slice(0, 3).map(Number) as [number, number, number];
    const z = this.zset(k);
    for (const [m, sc] of z) if (sc <= now - window) z.delete(m);
    let n = z.size;
    const admit = n < max;
    if (admit || argv[4] === '1') {
      z.set(String(argv[3]), now);
      n++;
    }
    if (admit) return [n, 0];
    return [n, [...z.values()].sort((a, b) => a - b)[n - max]];
  }
  counters = new Map<string, number>();
  blocks = new Map<string, number>();
  async ttl() {
    return -2;
  }
  async incr(k: string) {
    const n = (this.counters.get(k) ?? 0) + 1;
    this.counters.set(k, n);
    return n;
  }
  async pexpire() {
    return 1;
  }
  async set(k: string, _v: string, _mode: string, seconds: number) {
    this.blocks.set(k, seconds);
    return 'OK';
  }
}

/** Config source: the tier has no row (compiled default), the tenant has `max`. */
function fakeDb(tier: string, max: number) {
  const q = {
    select: () => q,
    where: () => q,
    executeTakeFirst: async () => undefined,
    execute: async () => [{ key_prefix: `tenant:${tier}`, window_ms: 60_000, max_requests: max }],
  };
  return { selectFrom: () => q } as never;
}

describe('tenant bucket next to the per-user bucket', () => {
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.NODE_ENV;
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
    process.env.TRUSTED_PROXY = 'true';
  });
  afterAll(() => {
    _setCacheForTests(null);
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
  });

  /** Per-user max 2, tenant max 3; `user` absent = anonymous. */
  function probe() {
    const tier = `tt-${crypto.randomUUID()}`;
    const app = new Hono();
    app.use('*', async (c, next) => {
      const user = c.req.header('x-user');
      c.set('prefetchedSession', user ? { user: { id: user } } : null);
      c.set('tenant', { id: T1 } as never);
      await next();
    });
    app.use('*', rateLimit({ keyPrefix: tier, max: 2, windowMs: 60_000, db: fakeDb(tier, 3) }));
    app.get('/p', (c) => c.text('ok'));
    const hit = async (ip: string, user?: string) => {
      const headers: Record<string, string> = { 'x-real-ip': ip };
      if (user) headers['x-user'] = user;
      const res = await app.request('/p', { headers });
      return res.status === 429 ? `429:${((await res.json()) as { error: string }).error}` : '200';
    };
    return { tier, hit };
  }

  for (const backend of ['valkey', 'memory'] as const) {
    it(`[${backend}] a caller refused by their own bucket does not spend the tenant's`, async () => {
      const cache = backend === 'valkey' ? new FakeValkey() : null;
      _setCacheForTests(cache as never);
      const { tier, hit } = probe();
      const own = 'Too Many Requests';
      const tenantMsg = 'Tenant rate limit exceeded';

      // X: two admitted, then refused by the per-user bucket — three times.
      expect([
        await hit('198.51.100.1', 'x'),
        await hit('198.51.100.1', 'x'),
        await hit('198.51.100.1', 'x'),
        await hit('198.51.100.1', 'x'),
        await hit('198.51.100.1', 'x'),
      ]).toEqual(['200', '200', `429:${own}`, `429:${own}`, `429:${own}`]);

      // Had those refusals reached the tenant bucket (3), Y would be refused at
      // once. Y gets the one slot left, then the tenant limit.
      expect(await hit('198.51.100.2', 'y')).toBe('200');
      expect(await hit('198.51.100.2', 'y')).toBe(`429:${tenantMsg}`);

      // Anonymous traffic is not counted against the tenant at all.
      expect(await hit('198.51.100.3')).toBe('200');

      // A tenant refusal is not recorded: the bucket holds exactly the admitted.
      if (cache) expect(cache.zset(`rl:${tier}:t:${T1}`).size).toBe(3);
    });
  }
});

describe('Retry-After on a refusal', () => {
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.NODE_ENV;
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY = 'true';
  });
  afterAll(() => {
    _setCacheForTests(null);
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
  });

  /** Per-user max 2 and tenant max 3, both over 60 s, on a clock the test sets. */
  function clocked(cache: FakeValkey | null) {
    _setCacheForTests(cache as never);
    const t0 = Date.now();
    let offset = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    const tier = `ra-${crypto.randomUUID()}`;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('prefetchedSession', { user: { id: c.req.header('x-user') as string } });
      c.set('tenant', { id: T1 } as never);
      await next();
    });
    app.use('*', rateLimit({ keyPrefix: tier, max: 2, windowMs: 60_000, db: fakeDb(tier, 3) }));
    app.get('/p', (c) => c.text('ok'));
    const at = async (seconds: number, user: string) => {
      offset = seconds * 1000;
      const res = await app.request('/p', {
        headers: { 'x-user': user, 'x-real-ip': '192.0.2.9' },
      });
      return res.status === 429 ? Number(res.headers.get('retry-after')) : res.status;
    };
    return { tier, at, restore: () => clock.mockRestore() };
  }

  for (const backend of ['valkey', 'memory'] as const) {
    it(`[${backend}] the tenant bucket names when its oldest entry expires, not a whole window`, async () => {
      const { at, restore } = clocked(backend === 'valkey' ? new FakeValkey() : null);
      try {
        expect([await at(0, 'a'), await at(10, 'b'), await at(20, 'c')]).toEqual([200, 200, 200]);
        // The first entry (t=0) leaves the window at t=60.
        expect(await at(25, 'd')).toBe(35);
      } finally {
        restore();
      }
    });
  }

  it('[valkey] a first per-user offence waits until a slot frees; a repeat keeps the block', async () => {
    const cache = new FakeValkey();
    const { tier, at, restore } = clocked(cache);
    try {
      expect([await at(0, 'u'), await at(10, 'u')]).toEqual([200, 200]);
      // Refusals count here, so the refused entry is in the set too: the next
      // request fits once the t=10 entry leaves, at t=70.
      expect(await at(20, 'u')).toBe(50);
      // A repeat offence: the escalated cooldown, and the block key carries it.
      expect(await at(21, 'u')).toBe(120);
      expect(cache.blocks.get(`rl:block:${tier}:u`)).toBe(120);
    } finally {
      restore();
    }
  });

  it('[memory] a per-user refusal waits until the fixed window starts over', async () => {
    const { at, restore } = clocked(null);
    try {
      expect([await at(0, 'u'), await at(10, 'u')]).toEqual([200, 200]);
      expect(await at(20, 'u')).toBe(40);
    } finally {
      restore();
    }
  });
});
