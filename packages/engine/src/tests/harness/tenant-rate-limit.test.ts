/**
 * The per-tenant traffic limit, through the real middleware chain.
 *
 * On a shared instance every tier bucket is keyed per user or address, so the
 * members of one tenant together could consume the capacity every other tenant
 * depends on. `tenant:<tier>` / `tenant:<tier>:<id>` rows in
 * `zv_rate_limit_configs` add a bucket per tenant, checked on top of the
 * caller's own.
 *
 * Asserted here, each against a fresh tenant so no case spends another's budget:
 *  - no row → nothing changes;
 *  - two members, each far under their own limit, together exhaust the tenant's,
 *    and the next request gets a 429 that names the tenant limit;
 *  - a second tenant is unaffected;
 *  - resolution: tenant override, then tenant default, then off;
 *  - anonymous requests naming a tenant do not spend its budget;
 *  - the admin API accepts only well-formed tenant keys, instance admins only.
 *
 * The limiter returns next() under NODE_ENV=test, so the environment is flipped
 * for the duration — otherwise this would measure the bypass. There is no Valkey
 * in the harness, so this drives the in-memory bucket; the Valkey branch has its
 * own unit test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';

const d = harnessAvailable() ? describe : describe.skip;

d('per-tenant rate limit', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const savedEnv = process.env.NODE_ENV;
  const savedProxy = process.env.TRUSTED_PROXY;
  const tenants: string[] = [];
  let ipSeq = 0;

  /** Each caller its own address, so the per-IP tier bucket never fires first. */
  const nextIp = () => `198.51.100.${++ipSeq}`;

  async function newTenant(): Promise<{ id: string; slug: string }> {
    const id = crypto.randomUUID();
    const slug = `trl-${id.slice(0, 8)}`;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${id}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    tenants.push(id);
    return { id, slug };
  }

  /** Sign-ups share one address; keep them out of the `auth` tier's 10/min. */
  async function newUser() {
    process.env.NODE_ENV = 'test';
    try {
      return await createMemberSession(app, db);
    } finally {
      process.env.NODE_ENV = 'development';
    }
  }

  async function member(tenantId: string): Promise<string> {
    const { cookie, userId } = await newUser();
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id)
              VALUES (${tenantId}::uuid, ${userId})`.execute(db);
    return cookie;
  }

  async function hit(slug: string, ip: string, cookie?: string) {
    const headers: Record<string, string> = { 'x-tenant-slug': slug, 'x-forwarded-for': ip };
    if (cookie) headers.cookie = cookie;
    return app.request('/api/me', { headers });
  }

  async function statuses(slug: string, ip: string, cookie: string | undefined, n: number) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await hit(slug, ip, cookie)).status);
    return out;
  }

  function patch(key: string, body: Record<string, unknown>, cookie = god, slug?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      cookie,
      'x-forwarded-for': nextIp(),
    };
    if (slug) headers['x-tenant-slug'] = slug;
    return app.request(`/api/admin/rate-limits/${key}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    process.env.NODE_ENV = 'development';
    // Without it X-Forwarded-For is ignored and every caller shares one address.
    process.env.TRUSTED_PROXY = 'true';
  });

  afterAll(async () => {
    process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix LIKE 'tenant:%'`.execute(db);
    invalidateRateLimitCache();
    for (const id of tenants) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${id}::uuid`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${id}::uuid`.execute(db);
    }
  });

  it('changes nothing while no tenant row exists', async () => {
    const a = await newTenant();
    const cookie = await member(a.id);
    const seen = await statuses(a.slug, nextIp(), cookie, 12);
    // The route itself must answer, or the limiter was never reached.
    expect(seen[0]).toBe(200);
    expect(seen).not.toContain(429);
  });

  it('two members together exhaust the tenant limit; another tenant is untouched', async () => {
    const a = await newTenant();
    const b = await newTenant();
    const [u1, u2, u3] = [await member(a.id), await member(a.id), await member(b.id)];
    const [ip1, ip2] = [nextIp(), nextIp()];

    expect((await patch(`tenant:api:${a.id}`, { window_ms: 60_000, max_requests: 6 })).status).toBe(
      200,
    );

    // Three each — nowhere near the per-user `api` tier (200/min).
    expect(await statuses(a.slug, ip1, u1, 3)).toEqual([200, 200, 200]);
    expect(await statuses(a.slug, ip2, u2, 3)).toEqual([200, 200, 200]);

    const refused = await hit(a.slug, ip1, u1);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(JSON.stringify(await refused.json())).toContain('Tenant rate limit exceeded');
    expect((await hit(a.slug, ip2, u2)).status).toBe(429);

    // The other tenant has no row of its own and no default applies.
    expect(await statuses(b.slug, nextIp(), u3, 8)).not.toContain(429);
  });

  it('resolves tenant override, then tenant default, then off', async () => {
    const c = await newTenant();
    const dT = await newTenant();
    const [uc, ud] = [await member(c.id), await member(dT.id)];

    expect(
      (await patch(`tenant:api:${dT.id}`, { window_ms: 60_000, max_requests: 8 })).status,
    ).toBe(200);
    // Every tenant without an override — the default tenant included — now has 4.
    // Kept last among the god's calls: the god's own traffic is counted too.
    expect((await patch('tenant:api', { window_ms: 60_000, max_requests: 4 })).status).toBe(200);

    const cSeen = await statuses(c.slug, nextIp(), uc, 5);
    expect(cSeen.slice(0, 4)).not.toContain(429);
    expect(cSeen[4]).toBe(429);

    // The override wins over the default.
    expect(await statuses(dT.slug, nextIp(), ud, 5)).not.toContain(429);

    // Deactivating the override drops the tenant back to the default (4), which
    // its five requests already exceed.
    await sql`UPDATE zv_rate_limit_configs SET is_active = false
              WHERE key_prefix = ${`tenant:api:${dT.id}`}`.execute(db);
    invalidateRateLimitCache(`tenant:api:${dT.id}`);
    expect((await hit(dT.slug, nextIp(), ud)).status).toBe(429);

    // And with the default gone too, the limit is off.
    await sql`DELETE FROM zv_rate_limit_configs WHERE key_prefix = 'tenant:api'`.execute(db);
    invalidateRateLimitCache('tenant:api');
    expect((await hit(dT.slug, nextIp(), ud)).status).toBe(200);
  });

  it('does not let anonymous callers spend a tenant budget by naming it', async () => {
    const e = await newTenant();
    const ue = await member(e.id);
    expect((await patch(`tenant:api:${e.id}`, { window_ms: 60_000, max_requests: 2 })).status).toBe(
      200,
    );

    for (let i = 0; i < 5; i++) {
      expect(await statuses(e.slug, nextIp(), undefined, 2)).not.toContain(429);
    }
    // The member still has the whole budget.
    expect(await statuses(e.slug, nextIp(), ue, 3)).toEqual([200, 200, 429]);
  });

  it('admin API: validates tenant keys and admits instance admins only', async () => {
    const f = await newTenant();
    for (const bad of ['tenant:nope', 'tenant:api:not-a-uuid', `tenant:api:${f.id}:x`, 'tenant:']) {
      expect((await patch(bad, { window_ms: 60_000, max_requests: 5 })).status).toBe(400);
    }
    // Creating needs both numbers; there is no seeded row to inherit them from.
    expect((await patch(`tenant:ai:${f.id}`, { max_requests: 5 })).status).toBe(400);

    // Stored lowercase, the form every lookup uses — an uppercase row would be dead.
    const created = await patch(`tenant:ai:${f.id.toUpperCase()}`, {
      window_ms: 30_000,
      max_requests: 5,
    });
    expect(created.status).toBe(200);
    const list = (await (
      await app.request('/api/admin/rate-limits', {
        headers: { cookie: god, 'x-forwarded-for': nextIp() },
      })
    ).json()) as { rate_limits: Array<{ key_prefix: string }>; tiers: string[] };
    expect(list.rate_limits.map((r) => r.key_prefix)).toContain(`tenant:ai:${f.id}`);
    expect(list.tiers).toContain('api');

    const audited = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log
       WHERE resource_type = 'rate_limit' AND resource_id = ${`tenant:ai:${f.id}`}`.execute(db);
    expect(audited.rows[0]?.n).toBe(1);

    // A delegated tenant admin must not raise their own tenant's limit.
    const { cookie, userId } = await newUser();
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id)
              VALUES (${f.id}::uuid, ${userId})`.execute(db);
    const enforcer = await getEnforcer();
    await enforcer.addRoleForUser(userId, 'tenant_admin', f.id);
    await invalidateUserPermCache(userId);
    const res = await patch(`tenant:ai:${f.id}`, { max_requests: 100_000 }, cookie, f.slug);
    await enforcer.deleteRoleForUser(userId, 'tenant_admin', f.id);
    expect(res.status).toBe(403);
  });
});
