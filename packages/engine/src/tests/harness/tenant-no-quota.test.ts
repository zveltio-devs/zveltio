/**
 * The engine meters nothing per tenant: no plan, no limits, no daily quota.
 *
 * It shipped a commercial layer — `plan`, `max_*` columns on `zv_tenants`, a
 * `zv_tenant_usage` ledger and a middleware that answered 429 "Upgrade your
 * plan" after `max_api_calls_day` requests. A BaaS has no plans; migration 018
 * drops all of it. The default tenant had already been exempted (016); a tenant
 * created through the API still got the free-plan column defaults, so its
 * request 10,001 of the day was refused.
 *
 * The cache below is seeded with the counter that middleware kept, standing at
 * 10,000 for today, so the request under test is number 10,001.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG } from '../../lib/tenancy/tenant-manager.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { FakeRedis } from '../../testing/fake-redis.js';

const d = harnessAvailable() ? describe : describe.skip;
const COMMERCIAL = [
  'plan',
  'max_records',
  'max_storage_gb',
  'max_api_calls_day',
  'max_users',
  'billing_email',
  'trial_ends_at',
];

d('tenants carry no plan and no quota', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let godEmail: string;
  const slug = `noquota-${Date.now()}`;
  let created: Record<string, unknown>;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const god = await db
      .selectFrom('user')
      .select('email')
      .where('role', '=', 'god')
      .executeTakeFirstOrThrow();
    godEmail = god.email;

    // Unknown fields are stripped, as every other zod schema in the routes does.
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        slug,
        name: 'No Quota Co',
        admin_user_email: godEmail,
        plan: 'enterprise',
        max_api_calls_day: 5,
        billing_email: 'billing@example.com',
      }),
    });
    expect(res.status).toBe(201);
    created = ((await res.json()) as { tenant: Record<string, unknown> }).tenant;
  });

  afterAll(async () => {
    _setCacheForTests(null);
    await db
      .deleteFrom('zv_tenants')
      .where('slug', '=', slug)
      .execute()
      .catch(() => {});
  });

  it('POST /api/tenants neither stores nor returns plan or limit fields', async () => {
    expect(created.slug).toBe(slug);
    for (const k of COMMERCIAL) expect(created).not.toHaveProperty(k);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'zv_tenants'
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('slug');
    for (const k of COMMERCIAL) expect(names).not.toContain(k);
    expect(names).toContain('settings');

    const usage = await sql<{ t: string | null }>`
      SELECT to_regclass('public.zv_tenant_usage')::text AS t
    `.execute(db);
    expect(usage.rows[0]?.t).toBeNull();
  });

  it('PATCH /api/tenants/:id ignores plan and limit fields', async () => {
    const res = await app.request(`/api/tenants/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Renamed Co', plan: 'pro', max_users: 1 }),
    });
    expect(res.status).toBe(200);
    const { tenant } = (await res.json()) as { tenant: Record<string, unknown> };
    expect(tenant.name).toBe('Renamed Co');
    for (const k of COMMERCIAL) expect(tenant).not.toHaveProperty(k);
  });

  it('the default tenant and a new tenant both serve request 10,001 of the day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cache = new FakeRedis();
    cache.store.set(`tq:${DEFAULT_TENANT_ID}:${today}`, '10000');
    cache.store.set(`tq:${created.id}:${today}`, '10000');
    _setCacheForTests(cache as unknown as Redis);

    const seen = [];
    for (const tenantSlug of [DEFAULT_TENANT_SLUG, slug]) {
      const res = await app.request('/api/health', { headers: { 'x-tenant-slug': tenantSlug } });
      seen.push({ tenantSlug, status: res.status, quota: res.headers.get('X-Tenant-Quota-Limit') });
    }
    expect(seen).toEqual([
      { tenantSlug: DEFAULT_TENANT_SLUG, status: 200, quota: null },
      { tenantSlug: slug, status: 200, quota: null },
    ]);
  });
});
