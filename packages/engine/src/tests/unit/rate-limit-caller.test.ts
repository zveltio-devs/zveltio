import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  authRateLimit,
  publicFormRateLimit,
  rateLimitCaller,
  scimRateLimit,
  shareLinkRateLimit,
} from '../../middleware/rate-limit.js';

/**
 * Which identity a tier bucket is keyed on. The end-to-end behaviour (sessions,
 * keys, the tenant bucket, bogus identities) is in
 * `harness/rate-limit-caller-identity.test.ts`; this pins what the harness
 * cannot reach cheaply: the tenant rule for keys, and the guessing surfaces
 * staying per IP for signed-in callers.
 */

const ROOT = '00000000-0000-0000-0000-000000000001';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

async function callerFor(vars: {
  session?: string;
  key?: { id: string; tenant_id: string | null } | null;
  tenant?: string;
}): Promise<string | undefined> {
  let out: string | undefined;
  const app = new Hono();
  app.get('/', (c) => {
    if (vars.session) c.set('prefetchedSession', { user: { id: vars.session } });
    if (vars.key !== undefined) c.set('prefetchedApiKey', vars.key as never);
    if (vars.tenant) c.set('tenant', { id: vars.tenant } as never);
    out = rateLimitCaller(c);
    return c.text('ok');
  });
  await app.request('/');
  return out;
}

describe('rateLimitCaller', () => {
  it('prefers the verified session, then a key valid in this tenant', async () => {
    expect(await callerFor({ session: 'u1', key: { id: 'k', tenant_id: T1 } })).toBe('u1');
    expect(await callerFor({ key: { id: 'k', tenant_id: T1 }, tenant: T1 })).toBe('apikey:k');
    // Root keys act anywhere, as in validateApiKey.
    expect(await callerFor({ key: { id: 'r', tenant_id: ROOT }, tenant: T2 })).toBe('apikey:r');
  });

  it('never keys on a key the auth path would refuse', async () => {
    // Another tenant's key, and the same key with no tenant resolved (= root).
    expect(await callerFor({ key: { id: 'k', tenant_id: T1 }, tenant: T2 })).toBeUndefined();
    expect(await callerFor({ key: { id: 'k', tenant_id: T1 } })).toBeUndefined();
    // Looked up, not found (a bogus key).
    expect(await callerFor({ key: null })).toBeUndefined();
    expect(await callerFor({})).toBeUndefined();
  });
});

describe('guessing surfaces stay per IP for signed-in callers', () => {
  let savedEnv: string | undefined;
  let savedProxy: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.NODE_ENV;
    savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
    process.env.TRUSTED_PROXY = 'true';
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
  });

  const surfaces: Array<[string, MiddlewareHandler, number, string]> = [
    ['auth', authRateLimit, 10, '203.0.113.201'],
    ['form', publicFormRateLimit, 20, '203.0.113.202'],
    ['share', shareLinkRateLimit, 10, '203.0.113.203'],
    ['scim', scimRateLimit, 100, '203.0.113.204'],
  ];

  for (const [name, limiter, max, ip] of surfaces) {
    it(`${name}: holding many accounts does not multiply the budget`, async () => {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('prefetchedSession', { user: { id: c.req.header('x-user') ?? '' } });
        await next();
      });
      app.use('*', limiter);
      app.get('/p', (c) => c.text('ok'));
      // A different signed-in account on every request, all from one address.
      const seen: number[] = [];
      for (let i = 0; i <= max; i++) {
        const res = await app.request('/p', { headers: { 'x-real-ip': ip, 'x-user': `u${i}` } });
        seen.push(res.status);
      }
      expect(seen.slice(0, max)).not.toContain(429);
      expect(seen[max]).toBe(429);
    });
  }
});
