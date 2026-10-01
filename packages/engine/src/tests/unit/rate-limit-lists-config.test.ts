/**
 * Middleware paths no unit test reached, each pinned by a mutation of
 * `middleware/rate-limit.ts` that survived every rate-limit test file:
 *
 *   - RATE_LIMIT_DENYLIST (403) and RATE_LIMIT_ALLOWLIST (no limit) — no test
 *     anywhere set either variable;
 *   - the live limits in `zv_rate_limit_configs`: the tier row, the per-API-key
 *     row over it, `is_active`, and the 60 s config cache;
 *   - the Valkey block key and the escalation on a repeat offence.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { Hono } from 'hono';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import {
  clearLocalRateLimitCache,
  escalationSeconds,
  parseTenantLimitKey,
  rateLimit,
  resetIpListsForTests,
} from '../../middleware/rate-limit.js';

const T1 = '0f8fad5b-d9cb-469f-a165-70867728950e';

type Row = { key_prefix: string; window_ms: number; max_requests: number; is_active: boolean };

/** A `zv_rate_limit_configs` that applies the `=` / `in` filters it is given. */
function tableDb(rows: Row[]) {
  return {
    selectFrom: () => {
      const filters: [string, string, unknown][] = [];
      const match = () =>
        rows.filter((r) =>
          filters.every(([col, op, val]) => {
            const v = r[col as keyof Row];
            return op === 'in' ? (val as unknown[]).includes(v) : v === val;
          }),
        );
      const q = {
        select: () => q,
        where: (col: string, op: string, val: unknown) => {
          filters.push([col, op, val]);
          return q;
        },
        executeTakeFirst: async () => match()[0],
        execute: async () => match(),
      };
      return q;
    },
  } as never;
}

const row = (key_prefix: string, max: number, is_active = true): Row => ({
  key_prefix,
  window_ms: 60_000,
  max_requests: max,
  is_active,
});

function probe(opts: { max: number; db?: unknown; apiKey?: string }) {
  const tier = `rlc-${crypto.randomUUID()}`;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('tenant', { id: T1 } as never);
    if (opts.apiKey) c.set('prefetchedApiKey', { id: opts.apiKey, tenant_id: T1 } as never);
    await next();
  });
  app.use(
    '*',
    rateLimit({ keyPrefix: tier, max: opts.max, windowMs: 60_000, db: opts.db as never }),
  );
  app.get('/p', (c) => c.text('ok'));
  const hit = async (ip = '198.51.100.1') =>
    (await app.request('/p', { headers: { 'x-real-ip': ip } })).status;
  return { tier, hit, app };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['NODE_ENV', 'TRUSTED_PROXY', 'RATE_LIMIT_DENYLIST', 'RATE_LIMIT_ALLOWLIST'])
    saved[k] = process.env[k];
  process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
  process.env.TRUSTED_PROXY = 'true';
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetIpListsForTests();
  _setCacheForTests(null);
  setSystemTime();
});
beforeEach(() => {
  delete process.env.RATE_LIMIT_DENYLIST;
  delete process.env.RATE_LIMIT_ALLOWLIST;
  resetIpListsForTests();
  _setCacheForTests(null);
});

describe('IP lists', () => {
  it('a denied address is refused with 403; others pass', async () => {
    process.env.RATE_LIMIT_DENYLIST = '203.0.113.0/24';
    resetIpListsForTests();
    const { hit } = probe({ max: 100 });
    expect(await hit('203.0.113.9')).toBe(403);
    expect(await hit('198.51.100.1')).toBe(200);
  });

  it('an allowed address is never limited; others are', async () => {
    process.env.RATE_LIMIT_ALLOWLIST = '203.0.113.5';
    resetIpListsForTests();
    const { hit } = probe({ max: 1 });
    expect([await hit('203.0.113.5'), await hit('203.0.113.5'), await hit('203.0.113.5')]).toEqual([
      200, 200, 200,
    ]);
    expect([await hit('198.51.100.1'), await hit('198.51.100.1')]).toEqual([200, 429]);
  });
});

describe('live limits from zv_rate_limit_configs', () => {
  it('the tier row replaces the compiled max', async () => {
    const rows: Row[] = [];
    const { tier, hit } = probe({ max: 100, db: tableDb(rows) });
    rows.push(row(tier, 1));
    expect([await hit(), await hit()]).toEqual([200, 429]);
  });

  it('an inactive row is ignored', async () => {
    const rows: Row[] = [];
    const { tier, hit } = probe({ max: 100, db: tableDb(rows) });
    rows.push(row(tier, 1, false));
    expect([await hit(), await hit()]).toEqual([200, 200]);
  });

  it('an API key’s own row wins over the tier row', async () => {
    const key = `k-${crypto.randomUUID()}`;
    const rows: Row[] = [];
    const { tier, hit } = probe({ max: 100, db: tableDb(rows), apiKey: key });
    rows.push(row(tier, 5), row(`apikey:${key}`, 1));
    expect([await hit(), await hit()]).toEqual([200, 429]);
  });

  it('a changed row is read again once the 60 s cache lapses', async () => {
    const rows: Row[] = [];
    const { tier, hit } = probe({ max: 100, db: tableDb(rows) });
    const t0 = Date.now() + 60 * 60_000;
    setSystemTime(new Date(t0));
    rows.push(row(tier, 1000));
    expect(await hit('198.51.100.10')).toBe(200); // caches max 1000
    rows[0] = row(tier, 1);
    setSystemTime(new Date(t0 + 61_000));
    expect([await hit('198.51.100.11'), await hit('198.51.100.11')]).toEqual([200, 429]);
    setSystemTime();
  });

  it('clearing a tenant key drops the cached tenant limit', async () => {
    const rows: Row[] = [];
    const tier = `rlt-${crypto.randomUUID()}`;
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('tenant', { id: T1 } as never);
      c.set('prefetchedSession', { user: { id: c.req.header('x-user') } } as never);
      await next();
    });
    app.use('*', rateLimit({ keyPrefix: tier, max: 100, windowMs: 60_000, db: tableDb(rows) }));
    app.get('/p', (c) => c.text('ok'));
    const hit = async (user: string) =>
      (await app.request('/p', { headers: { 'x-real-ip': '198.51.100.1', 'x-user': user } }))
        .status;
    rows.push(row(`tenant:${tier}`, 1));
    expect([await hit('a'), await hit('b')]).toEqual([200, 429]);
    rows[0] = row(`tenant:${tier}`, 100);
    clearLocalRateLimitCache(`tenant:${tier}`);
    expect(await hit('c')).toBe(200);
  });
});

describe('Valkey block and escalation', () => {
  /** Refuses every request; records what the limiter writes. */
  function refusingValkey(blockTtl: number) {
    return {
      evals: 0,
      sets: [] as [string, number][],
      async ttl() {
        return blockTtl;
      },
      async eval() {
        this.evals++;
        return [2, Date.now()];
      },
      offences: 0,
      async incr() {
        return ++this.offences;
      },
      async pexpire() {
        return 1;
      },
      async set(k: string, _v: string, _mode: string, seconds: number) {
        this.sets.push([k, seconds]);
        return 'OK';
      },
    };
  }

  it('a live block key refuses before counting, with its TTL as Retry-After', async () => {
    const cache = refusingValkey(42);
    _setCacheForTests(cache as never);
    const { app } = probe({ max: 1 });
    const res = await app.request('/p', { headers: { 'x-real-ip': '198.51.100.1' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(cache.evals).toBe(0);
  });

  it('a repeat offence blocks for the escalated time', async () => {
    const cache = refusingValkey(-2);
    _setCacheForTests(cache as never);
    const { tier, app } = probe({ max: 1 });
    const req = () => app.request('/p', { headers: { 'x-real-ip': '198.51.100.1' } });
    expect((await req()).status).toBe(429);
    expect(cache.sets).toEqual([]);
    const second = await req();
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe(String(escalationSeconds(2, 60)));
    expect(cache.sets).toEqual([[`rl:block:${tier}:198.51.100.1`, escalationSeconds(2, 60)]]);
  });
});

describe('parseTenantLimitKey', () => {
  it('lower-cases the tenant id', () => {
    expect(parseTenantLimitKey(`tenant:api:${T1.toUpperCase()}`)?.tenantId).toBe(T1);
  });
});
