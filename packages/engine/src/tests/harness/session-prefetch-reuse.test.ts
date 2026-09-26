/**
 * One session lookup per request, and a caller-keyed `files` budget.
 *
 * `sessionPrefetch` resolves the session before the tenant transaction. The
 * membership check and the `/ext/*` auth gate asked Better Auth again on the
 * same request, and `/files/*` had no prefetch at all, so its limiter bucketed
 * every signed-in caller per IP: one office NAT, one gallery budget.
 *
 * Counted with a spy on the live `getSession`. NODE_ENV is flipped off `test`
 * where the limiter must run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

type Api = { getSession: (...args: unknown[]) => Promise<unknown> };

d('session prefetch reuse', () => {
  let app: Hono;
  let db: Database;
  let api: Api;
  let original: Api['getSession'];
  let lookups = 0;
  let failNext = false;
  const savedEnv = process.env.NODE_ENV;
  const savedProxy = process.env.TRUSTED_PROXY;
  const tenant = { id: '', slug: '' };
  let ipSeq = 0;
  const nextIp = () => `198.51.100.${150 + ++ipSeq}`;

  async function counted(path: string, headers: Record<string, string>) {
    lookups = 0;
    const res = await app.request(path, { headers });
    return { status: res.status, lookups };
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    tenant.id = crypto.randomUUID();
    tenant.slug = `spr-${tenant.id.slice(0, 8)}`;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${tenant.id}::uuid, ${tenant.slug}, ${tenant.slug}, 'active')`.execute(db);
    api = (getAuth() as unknown as { api: Api }).api;
    original = api.getSession;
    api.getSession = (...args: unknown[]) => {
      lookups++;
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('lookup outage'));
      }
      return original(...args);
    };
  });

  afterAll(async () => {
    api.getSession = original;
    process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix = 'files'`.execute(db);
    invalidateRateLimitCache('files');
    await sql`DELETE FROM zv_tenants WHERE id = ${tenant.id}::uuid`.execute(db);
  });

  it('looks the session up once on a non-default tenant, and still refuses a non-member', async () => {
    const outsider = await createMemberSession(app, db);
    const res = await counted('/api/me', { cookie: outsider.cookie, 'x-tenant-slug': tenant.slug });
    expect(res.status).toBe(403);
    expect(res.lookups).toBe(1);
  });

  it('asks again when the prefetch failed, and still refuses a non-member', async () => {
    const outsider = await createMemberSession(app, db);
    failNext = true;
    const res = await counted('/api/me', { cookie: outsider.cookie, 'x-tenant-slug': tenant.slug });
    expect(res.status).toBe(403);
    expect(res.lookups).toBe(2);
  });

  it('admits a member of a non-default tenant without a lookup of its own', async () => {
    const member = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id)
              VALUES (${tenant.id}::uuid, ${member.userId})`.execute(db);
    // `/api/me` asks for the session itself; the default tenant skips membership.
    const baseline = await counted('/api/me', { cookie: member.cookie });
    const res = await counted('/api/me', { cookie: member.cookie, 'x-tenant-slug': tenant.slug });
    expect(res.status).toBe(200);
    expect(res.lookups).toBe(baseline.lookups);
  });

  it('looks the session up once through the /ext/* auth gate', async () => {
    const member = await createMemberSession(app, db);
    const res = await counted('/ext/no-such-extension/x', { cookie: member.cookie });
    expect(res.status).not.toBe(401);
    expect(res.lookups).toBe(1);
  });

  it('costs an anonymous /files request no session lookup, a signed-in one exactly one', async () => {
    expect((await counted('/files/media/nothing.png', {})).lookups).toBe(0);
    const range = { range: 'bytes=0-99', cookie: 'theme=dark' };
    expect((await counted('/files/media/nothing.png', range)).lookups).toBe(0);
    // A key header is a credential too: the prefetch runs.
    const key = { 'x-api-key': 'zvk_not_a_real_key' };
    expect((await counted('/files/media/nothing.png', key)).lookups).toBe(1);
    const bearer = { authorization: 'Bearer zvk_not_a_real_key' };
    expect((await counted('/files/media/nothing.png', bearer)).lookups).toBe(1);
    // With a session cookie, exactly the prefetch.
    const member = await createMemberSession(app, db);
    expect((await counted('/files/media/nothing.png', { cookie: member.cookie })).lookups).toBe(1);
  });

  it('gives two signed-in users on one address their own files budget', async () => {
    const [a, b] = [await createMemberSession(app, db), await createMemberSession(app, db)];
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY = 'true';
    try {
      // Not PATCH: `files` has no seeded row, so `PATCH /api/admin/rate-limits/files` is a 404.
      await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
                VALUES ('files', 60000, 2)
                ON CONFLICT (key_prefix) DO UPDATE SET max_requests = 2`.execute(db);
      invalidateRateLimitCache('files');

      const office = nextIp();
      const get = (cookie?: string) =>
        app.request('/files/media/nothing.png', {
          headers: { 'x-forwarded-for': office, ...(cookie ? { cookie } : {}) },
        });
      const seen: number[] = [];
      for (let i = 0; i < 3; i++) seen.push((await get(a.cookie)).status);
      expect(seen.slice(0, 2)).not.toContain(429);
      expect(seen[2]).toBe(429);
      // Same address, different person: a bucket of their own.
      expect((await get(b.cookie)).status).not.toBe(429);
      // Anonymous callers still share the address's bucket.
      const anon: number[] = [];
      for (let i = 0; i < 3; i++) anon.push((await get()).status);
      expect(anon[2]).toBe(429);
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
