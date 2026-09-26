import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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

/** Just enough of ioredis for the limiter: sorted sets in a pipeline. */
class FakeValkey {
  zsets = new Map<string, Map<string, number>>();
  zset(k: string) {
    if (!this.zsets.has(k)) this.zsets.set(k, new Map());
    return this.zsets.get(k) as Map<string, number>;
  }
  pipeline() {
    const ops: Array<() => unknown> = [];
    const p = {
      zremrangebyscore: (k: string, min: number, max: number) => {
        ops.push(() => {
          for (const [m, sc] of this.zset(k)) if (sc >= min && sc <= max) this.zset(k).delete(m);
        });
        return p;
      },
      zadd: (k: string, sc: number, m: string) => {
        ops.push(() => this.zset(k).set(m, sc));
        return p;
      },
      zcard: (k: string) => {
        ops.push(() => this.zset(k).size);
        return p;
      },
      pexpire: () => {
        ops.push(() => 1);
        return p;
      },
      exec: async () => ops.map((f) => [null, f()]),
    };
    return p;
  }
  async zrem(k: string, m: string) {
    return this.zset(k).delete(m) ? 1 : 0;
  }
  async ttl() {
    return -2;
  }
  async incr() {
    return 1;
  }
  async pexpire() {
    return 1;
  }
  async set() {
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
