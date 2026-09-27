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
import { revokeAllUserSessions } from '../../lib/auth.js';
import { __sweepIdle } from '../../lib/tenancy/index.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { _wsPermCacheForTests, websocketHandler } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
  wsUpgradeData,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

type Api = { getSession: (...args: unknown[]) => Promise<unknown> };

d('session prefetch reuse', () => {
  let app: Hono;
  let db: Database;
  let api: Api;
  let original: Api['getSession'];
  let lookups = 0;
  let failNext = false;
  /** Runs once, right after the next lookup answers: a revoke landing there. */
  let afterNextLookup: (() => Promise<void>) | null = null;
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
      const hook = afterNextLookup;
      afterNextLookup = null;
      if (!hook) return original(...args);
      return original(...args).then(async (session) => {
        await hook();
        return session;
      });
    };
  });

  afterAll(async () => {
    api.getSession = original;
    process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    // Back to the seeded default (migration 019), not deleted: later suites PATCH it.
    await sql`UPDATE zv_rate_limit_configs SET window_ms = 60000, max_requests = 1200
              WHERE key_prefix = 'files'`.execute(db);
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
    // The default tenant skips membership: whatever it costs is the route's own.
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

  it('looks the session up once for /api/me, a realtime route and an rpc route', async () => {
    const member = await createMemberSession(app, db);
    const me = await counted('/api/me', { cookie: member.cookie });
    expect(me.status).toBe(200);
    expect(me.lookups).toBe(1);
    const presence = await counted('/api/realtime/presence/spr-room', { cookie: member.cookie });
    expect(presence.status).toBe(200);
    expect(presence.lookups).toBe(1);
    const god = await createGodSession(app, db);
    const rpc = await counted('/api/rpc', { cookie: god });
    expect(rpc.status).toBe(200);
    expect(rpc.lookups).toBe(1);
  });

  // The prefetch answers before the route runs, so a revoke can land between
  // them. The route's sweep generation must predate the lookup it trusts, or
  // the sweep that revoke ran missed the connection and nothing re-checks it.
  it('closes a socket whose session was revoked between the prefetch and the upgrade', async () => {
    const member = await createMemberSession(app, db);
    afterNextLookup = () => revokeAllUserSessions(db, member.userId);
    const data = await wsUpgradeData(app, { cookie: member.cookie });
    expect(data).toBeDefined();
    const id = `ws_spr_${Date.now()}`;
    const closed: Array<{ code: number; reason: string }> = [];
    const ws = {
      data: { ...data, id },
      send: () => {},
      close: (code: number, reason: string) => {
        closed.push({ code, reason });
      },
    };
    try {
      websocketHandler.open(ws as never);
      for (let i = 0; i < 100 && closed.length === 0; i++) await Bun.sleep(20);
      await __sweepIdle();
      expect(closed[0]).toEqual({ code: 4001, reason: 'Unauthorized' });
    } finally {
      _wsPermCacheForTests().connections.delete(id);
    }
  });

  it('leaves no stream open whose session was revoked between the prefetch and the route', async () => {
    const member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: 'spr_stream', actions: ['read'] }],
    });
    afterNextLookup = () => revokeAllUserSessions(db, member.userId);
    const res = await app.request('/api/realtime/stream?collection=spr_stream', {
      headers: { cookie: member.cookie },
    });
    const reader = res.status === 200 ? res.body?.getReader() : undefined;
    try {
      await reader?.read(); // `connected`: the stream is registered
      const open = () => _sseConnectionsForTests().has(member.userId);
      for (let i = 0; i < 100 && open(); i++) await Bun.sleep(20);
      await __sweepIdle();
      expect(open()).toBe(false);
    } finally {
      await reader?.cancel().catch(() => {});
    }
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
      await sql`UPDATE zv_rate_limit_configs SET max_requests = 2
                WHERE key_prefix = 'files'`.execute(db);
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
