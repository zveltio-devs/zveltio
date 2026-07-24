/**
 * Tenant daily API-quota middleware (middleware/tenant-quota.ts).
 *
 * The quota is a fail-OPEN control mounted on all of /api/*, and until now no
 * test exercised the enforcement path — a regression that silently disabled it
 * (or never returned 429) would have been invisible. These tests inject a
 * complete in-memory cache and drive a low limit past its ceiling, asserting the
 * counter increments, the quota headers are exposed, and the request past the
 * limit is rejected with 429.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { tenantQuota } from '../../middleware/tenant-quota.js';
import type { Database } from '../../db/index.js';

/** Minimal in-memory stand-in for the ioredis methods the middleware calls. */
function fakeCache(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    async get(k: string) {
      return store.has(k) ? store.get(k)! : null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
    async incr(k: string) {
      const n = (parseInt(store.get(k) ?? '0', 10) || 0) + 1;
      store.set(k, String(n));
      return n;
    },
    async expire() {
      return 1;
    },
  } as unknown as Redis;
}

function appWith(cache: Redis, tenantId: string | null = 't1') {
  _setCacheForTests(cache);
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (tenantId) c.set('tenant', { id: tenantId } as never);
    await next();
  });
  app.use('/api/*', tenantQuota({} as Database));
  app.get('/api/x', (c) => c.text('ok'));
  return app;
}

describe('tenantQuota enforcement', () => {
  afterEach(() => _setCacheForTests(null));

  it('allows up to the limit then returns 429, with quota headers', async () => {
    // Pre-seed the limit key so the DB lookup is never taken.
    const app = appWith(fakeCache({ 'tq:limit:t1': '2' }));

    const r1 = await app.request('/api/x');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Tenant-Quota-Limit')).toBe('2');
    expect(r1.headers.get('X-Tenant-Quota-Remaining')).toBe('1');

    const r2 = await app.request('/api/x');
    expect(r2.status).toBe(200);
    expect(r2.headers.get('X-Tenant-Quota-Remaining')).toBe('0');

    const r3 = await app.request('/api/x');
    expect(r3.status).toBe(429);
    expect(((await r3.json()) as { error: string }).error).toMatch(/quota exceeded/i);
  });

  it('a limit of 0 (unconfigured) never blocks', async () => {
    const app = appWith(fakeCache({ 'tq:limit:t1': '0' }));
    for (let i = 0; i < 5; i++) {
      expect((await app.request('/api/x')).status).toBe(200);
    }
  });

  it('single-tenant (no tenant context) skips the quota entirely', async () => {
    const app = appWith(fakeCache({ 'tq:limit:t1': '1' }), null);
    // No tenant.id → middleware early-returns; the seeded limit is ignored.
    expect((await app.request('/api/x')).status).toBe(200);
    expect((await app.request('/api/x')).status).toBe(200);
  });
});
