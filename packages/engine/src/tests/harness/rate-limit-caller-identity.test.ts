/**
 * Who the tier limiters count, through the real middleware chain.
 *
 * The `/api/*` limiters are mounted before any route authenticates, and they
 * read `c.get('user')`, which only a route sets. So every bucket was keyed per
 * IP: behind one office NAT, every user shared one `api` budget, the
 * `apikey:<id>` override never applied, and API-key traffic never reached the
 * per-tenant bucket.
 *
 * Asserted:
 *  - two users on one address each get their own `api` budget;
 *  - an `apikey:<id>` override applies on `/api/*`;
 *  - an API key's requests count against the tenant bucket;
 *  - a bogus key, a foreign-tenant key or a bogus session is bucketed per IP,
 *    so rotating fake identities never buys a fresh bucket;
 *  - anonymous requests naming a tenant never spend its bucket;
 *  - a `perIp` tier (sign-in) stays per IP for signed-in callers too, so N
 *    accounts never buy N guessing budgets.
 *
 * NODE_ENV is flipped off `test` for the duration, or the limiter is bypassed.
 * No Valkey in the harness: this drives the in-memory bucket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  createKeyCreator,
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

d('rate limit caller identity', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const savedEnv = process.env.NODE_ENV;
  const savedProxy = process.env.TRUSTED_PROXY;
  const tenants: string[] = [];
  const keyNames: string[] = [];
  let ipSeq = 0;
  const nextIp = () => `198.51.100.${100 + ++ipSeq}`;

  async function newUser() {
    process.env.NODE_ENV = 'test';
    try {
      return await createMemberSession(app, db);
    } finally {
      process.env.NODE_ENV = 'development';
    }
  }

  async function newKey(tenantId: string): Promise<{ raw: string; id: string }> {
    const raw = generateApiKey();
    const name = `rlid-${STAMP}-${keyNames.length}`;
    keyNames.push(name);
    const row = await sql<{ id: string }>`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
      VALUES (${name}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              '["*"]'::jsonb, true, ${tenantId}::uuid, ${await createKeyCreator(db, [tenantId])})
      RETURNING id`.execute(db);
    return { raw, id: row.rows[0]!.id };
  }

  async function newTenant(): Promise<{ id: string; slug: string }> {
    const id = crypto.randomUUID();
    const slug = `rlid-${id.slice(0, 8)}`;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${id}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    tenants.push(id);
    return { id, slug };
  }

  async function hit(ip: string, extra: Record<string, string> = {}) {
    return app.request('/api/me', { headers: { 'x-forwarded-for': ip, ...extra } });
  }

  async function setTier(tier: string, max: number) {
    await sql`UPDATE zv_rate_limit_configs SET max_requests = ${max}
              WHERE key_prefix = ${tier}`.execute(db);
    invalidateRateLimitCache(tier);
  }
  const setApiTier = (max: number) => setTier('api', max);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY = 'true';
  });

  afterAll(async () => {
    process.env.NODE_ENV = savedEnv;
    if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = savedProxy;
    await setApiTier(200);
    await setTier('auth', 10);
    await sql`DELETE FROM zv_rate_limit_configs
              WHERE key_prefix LIKE 'tenant:%' OR key_prefix LIKE 'apikey:%'`.execute(db);
    invalidateRateLimitCache();
    for (const name of keyNames) {
      await sql`DELETE FROM zv_api_keys WHERE name = ${name}`.execute(db);
    }
    for (const id of tenants) await sql`DELETE FROM zv_tenants WHERE id = ${id}::uuid`.execute(db);
  });

  it('gives two users on one address their own api budget', async () => {
    const [a, b] = [await newUser(), await newUser()];
    const res = await app.request('/api/admin/rate-limits/api', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: god, 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ max_requests: 3 }),
    });
    expect(res.status).toBe(200);

    const office = nextIp();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push((await hit(office, { cookie: a.cookie })).status);
    expect(seen).toEqual([200, 200, 200, 429]);
    // Same address, different person: a bucket of their own.
    expect((await hit(office, { cookie: b.cookie })).status).toBe(200);
    await setApiTier(200);
  });

  it('applies an apikey:<id> override on /api/*', async () => {
    const key = await newKey('00000000-0000-0000-0000-000000000001');
    await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
              VALUES (${`apikey:${key.id}`}, 60000, 2)`.execute(db);
    invalidateRateLimitCache(`apikey:${key.id}`);

    // A fresh address per request: only the key can tie them together.
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((await hit(nextIp(), { 'x-api-key': key.raw })).status);
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);
  });

  // zv_api_keys.rate_limit: the key's own limit, per hour, a bucket next to the
  // tier's and god's override (migration 056). It only tightens.
  it("applies a key's own limit, and it cannot loosen god's override", async () => {
    const own = await newKey('00000000-0000-0000-0000-000000000001');
    await sql`UPDATE zv_api_keys SET rate_limit = 2 WHERE id = ${own.id}::uuid`.execute(db);
    const seen: Response[] = [];
    for (let i = 0; i < 3; i++) seen.push(await hit(nextIp(), { 'x-api-key': own.raw }));
    expect(seen.slice(0, 2).map((r) => r.status)).not.toContain(429);
    expect(seen[2]!.status).toBe(429);
    expect(await seen[2]!.text()).toContain('API key rate limit exceeded');

    const loose = await newKey('00000000-0000-0000-0000-000000000001');
    await sql`UPDATE zv_api_keys SET rate_limit = 1000000 WHERE id = ${loose.id}::uuid`.execute(db);
    await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
              VALUES (${`apikey:${loose.id}`}, 60000, 2)`.execute(db);
    invalidateRateLimitCache(`apikey:${loose.id}`);
    const looseSeen: number[] = [];
    for (let i = 0; i < 3; i++) {
      looseSeen.push((await hit(nextIp(), { 'x-api-key': loose.raw })).status);
    }
    expect(looseSeen[2]).toBe(429);
  });

  it("spends a key's own limit once per request, whatever tiers it passes", async () => {
    const key = await newKey('00000000-0000-0000-0000-000000000001');
    await sql`UPDATE zv_api_keys SET rate_limit = 2 WHERE id = ${key.id}::uuid`.execute(db);
    // A data write meets the `write` and the `api` limiters.
    const write = () =>
      app.request('/api/data/rlid_none', {
        method: 'POST',
        headers: { 'x-api-key': key.raw, 'x-forwarded-for': nextIp() },
        body: '{}',
      });
    const seen = [(await write()).status, (await write()).status, (await write()).status];
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);
  });

  it('a new key has no own limit unless asked; a limit below 1 is refused', async () => {
    const create = (suffix: string, extra: Record<string, unknown> = {}) => {
      const name = `rlid-${STAMP}-${suffix}`;
      keyNames.push(name);
      return app.request('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: god, 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ name, ...extra }),
      });
    };
    const plain = await create('plain');
    expect(plain.status).toBe(200);
    const limited = await create('limited', { rate_limit: 50 });
    const rows = await sql<{ name: string; rate_limit: number | null }>`
      SELECT name, rate_limit FROM zv_api_keys
       WHERE name IN (${`rlid-${STAMP}-plain`}, ${`rlid-${STAMP}-limited`}) ORDER BY name`.execute(
      db,
    );
    expect(limited.status).toBe(200);
    expect(rows.rows).toEqual([
      { name: `rlid-${STAMP}-limited`, rate_limit: 50 },
      { name: `rlid-${STAMP}-plain`, rate_limit: null },
    ]);
    expect((await create('zero', { rate_limit: 0 })).status).toBe(400);
  });

  it('counts API-key traffic against the tenant bucket', async () => {
    const t = await newTenant();
    const key = await newKey(t.id);
    const headers = { 'x-api-key': key.raw, 'x-tenant-slug': t.slug };
    // A request before the limit exists caches "no limit" for this tenant; the
    // override's invalidation must drop that, or the limit never applies.
    expect((await hit(nextIp(), headers)).status).not.toBe(429);
    await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
              VALUES (${`tenant:api:${t.id}`}, 60000, 2)`.execute(db);
    invalidateRateLimitCache(`tenant:api:${t.id}`);

    const seen: number[] = [];
    for (let i = 0; i < 3; i++) seen.push((await hit(nextIp(), headers)).status);
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);
  });

  it('buckets bogus and foreign identities per IP', async () => {
    const t = await newTenant();
    // Valid, but for another tenant: sent with no slug it acts in root and is refused.
    const foreign = await newKey(t.id);
    const { cookie } = await newUser();
    const bogusCookie = cookie.replace(/=([^;]+)/, '=forged$1');
    await setApiTier(3);

    const ip = nextIp();
    const seen = [
      (await hit(ip, { 'x-api-key': generateApiKey() })).status,
      (await hit(ip, { 'x-api-key': generateApiKey() })).status,
      (await hit(ip, { 'x-api-key': foreign.raw })).status,
      (await hit(ip, { cookie: bogusCookie })).status,
      (await hit(ip, { 'x-api-key': generateApiKey() })).status,
    ];
    await setApiTier(200);
    expect(seen.slice(0, 3)).not.toContain(429);
    expect(seen.slice(3)).toEqual([429, 429]);
  });

  it('never spends a tenant bucket on anonymous requests naming it', async () => {
    const t = await newTenant();
    const key = await newKey(t.id);
    await sql`INSERT INTO zv_rate_limit_configs (key_prefix, window_ms, max_requests)
              VALUES (${`tenant:api:${t.id}`}, 60000, 2)`.execute(db);
    invalidateRateLimitCache(`tenant:api:${t.id}`);

    // Anyone can name a tenant; counting them would let a few addresses lock it out.
    for (let i = 0; i < 3; i++) await hit(nextIp(), { 'x-tenant-slug': t.slug });
    const headers = { 'x-api-key': key.raw, 'x-tenant-slug': t.slug };
    expect((await hit(nextIp(), headers)).status).not.toBe(429);
  });

  it('keeps a perIp tier per address for signed-in callers', async () => {
    const users = [await newUser(), await newUser(), await newUser()];
    await setTier('auth', 2);
    const ip = nextIp();
    const seen: number[] = [];
    for (const u of users) {
      const res = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: u.cookie, 'x-forwarded-for': ip },
        body: JSON.stringify({ email: `nobody-${STAMP}@example.test`, password: 'wrong-password' }),
      });
      seen.push(res.status);
    }
    await setTier('auth', 10);
    expect(seen.slice(0, 2)).not.toContain(429);
    expect(seen[2]).toBe(429);
  });
});
