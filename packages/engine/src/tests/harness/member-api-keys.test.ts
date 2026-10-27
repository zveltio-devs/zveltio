/**
 * A member issues their own API keys at /api/me/api-keys (ADR 0010 items 2-4, 6).
 *
 * Off unless the instance switches it on; a fresh step-up per key; explicit
 * scopes without `$schema`; `rls_bypass` only with `data:view_all`; an expiry
 * within a year; at most ten active keys, even when created concurrently; a
 * member revokes only their own; the keys share the member's rate-limit bucket;
 * created and revoked are audited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _settleAuditWrites } from '../../lib/audit.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { invalidateRateLimitCache } from '../../middleware/rate-limit.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `mak-${crypto.randomUUID().slice(0, 8)}`;
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

d('members issue their own API keys (ADR 0010)', () => {
  let app: Hono;
  let db: Database;
  const tenants: string[] = [];

  type Member = Awaited<ReturnType<typeof createMemberSession>>;
  const member = (grants?: Array<{ collection: string; actions: string[] }>) =>
    createMemberSession(app, db, { configWindow: true, grants });

  const create = async (m: Member, body: Record<string, unknown> = {}, stepUp = true) =>
    app.request('/api/me/api-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        cookie: m.cookie,
        ...(stepUp ? await m.stepUp!('api_key.create') : {}),
      },
      body: JSON.stringify({
        name: NAME,
        scopes: [{ collection: 'mak_none', actions: ['read'] }],
        expires_at: inDays(90),
        ...body,
      }),
    });

  const revoke = (m: Member, id: string) =>
    app.request(`/api/me/api-keys/${id}`, { method: 'DELETE', headers: { cookie: m.cookie } });

  const self = (key: string, ip?: string) =>
    app.request('/api/api-keys/self', {
      headers: { 'X-API-Key': key, ...(ip ? { 'x-forwarded-for': ip } : {}) },
    });

  const setSwitch = async (on: boolean) => {
    await sql`DELETE FROM zv_settings WHERE key = 'member_api_keys'`.execute(db);
    if (on)
      await sql`INSERT INTO zv_settings (key, value) VALUES ('member_api_keys', 'true'::jsonb)`.execute(
        db,
      );
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await setSwitch(false);
  });

  afterAll(async () => {
    await setSwitch(false);
    await sql`DELETE FROM zv_api_keys WHERE name = ${NAME}`.execute(db);
    for (const id of tenants) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${id}::uuid`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${id}::uuid`.execute(db);
    }
  });

  it('is off until the instance switches it on, through the settings API', async () => {
    const m = await member();
    const off = await create(m);
    expect(off.status).toBe(403);
    expect(((await off.json()) as { code: string }).code).toBe('member_api_keys_off');

    const god = await createGodSession(app, db);
    const put = await app.request('/api/settings/member_api_keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ value: true }),
    });
    expect(put.status).toBe(200);
    expect((await create(m)).status).toBe(200);
  });

  it('refuses without a step-up, and a key cannot reach it', async () => {
    await setSwitch(true);
    const m = await member();
    const res = await create(m, {}, false);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('step_up_required');

    const { key } = (await (await create(m)).json()) as { key: string };
    const asKey = await app.request('/api/me/api-keys', { headers: { 'X-API-Key': key } });
    expect(asKey.status).toBe(403);
  });

  it('refuses $schema, empty scopes, and an expiry missing, past or beyond a year', async () => {
    await setSwitch(true);
    const m = await member();
    const schema = await create(m, { scopes: [{ collection: '$schema', actions: ['read'] }] });
    expect(schema.status).toBe(400);
    expect((await create(m, { scopes: [] })).status).toBe(400);
    expect((await create(m, { expires_at: undefined })).status).toBe(400);
    expect((await create(m, { expires_at: inDays(-1) })).status).toBe(400);
    expect((await create(m, { expires_at: inDays(366) })).status).toBe(400);
    expect((await create(m, { expires_at: 'soon' })).status).toBe(400);
    expect((await create(m, { expires_at: inDays(364) })).status).toBe(200);
  });

  it('grants rls_bypass only to a member who holds data:view_all', async () => {
    await setSwitch(true);
    expect((await create(await member(), { rls_bypass: true })).status).toBe(403);
    const holder = await member([{ collection: 'data', actions: ['view_all'] }]);
    const ok = await create(holder, { rls_bypass: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { rls_bypass: boolean }).rls_bypass).toBe(true);
  });

  it('holds at most ten active keys, even when the eleventh races the tenth', async () => {
    await setSwitch(true);
    const m = await member();
    const headers = [];
    for (let i = 0; i < 13; i++) headers.push(await m.stepUp!('api_key.create'));
    const statuses = (
      await Promise.all(
        headers.map((h) =>
          app.request('/api/me/api-keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', cookie: m.cookie, ...h },
            body: JSON.stringify({
              name: NAME,
              scopes: [{ collection: 'mak_none', actions: ['read'] }],
              expires_at: inDays(30),
            }),
          }),
        ),
      )
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);

    const list = (await (
      await app.request('/api/me/api-keys', { headers: { cookie: m.cookie } })
    ).json()) as { api_keys: Array<{ id: string; key_hash?: string; key?: string }> };
    expect(list.api_keys).toHaveLength(10);
    expect(list.api_keys.some((k) => 'key_hash' in k || 'key' in k)).toBe(false);

    // Revoking one frees a slot.
    expect((await revoke(m, list.api_keys[0]!.id)).status).toBe(200);
    expect((await create(m)).status).toBe(200);
  });

  it('revokes only the caller own key, and a revoked key stops at once', async () => {
    await setSwitch(true);
    const [owner, other] = [await member(), await member()];
    const { id, key } = (await (await create(owner)).json()) as { id: string; key: string };
    expect((await self(key)).status).toBe(200);

    expect((await revoke(other, id)).status).toBe(404);
    expect((await revoke(owner, 'not-a-uuid')).status).toBe(404);
    expect((await self(key)).status).toBe(200);

    expect((await revoke(owner, id)).status).toBe(200);
    expect((await self(key)).status).toBe(401);
    expect((await revoke(owner, id)).status).toBe(404);

    await _settleAuditWrites();
    const audit = await sql<{ event_type: string; user_id: string; tenant_id: string }>`
      SELECT event_type, user_id, tenant_id::text AS tenant_id FROM zv_audit_log
       WHERE resource_type = 'api_key' AND resource_id = ${id} ORDER BY created_at`.execute(db);
    expect(audit.rows).toEqual([
      { event_type: 'api_key.created', user_id: owner.userId, tenant_id: DEFAULT_TENANT_ID },
      { event_type: 'api_key.revoked', user_id: owner.userId, tenant_id: DEFAULT_TENANT_ID },
    ]);
  });

  it('issues the key in the tenant the request acts in', async () => {
    await setSwitch(true);
    const m = await member();
    const tenant = crypto.randomUUID();
    const slug = `mak-${tenant.slice(0, 8)}`;
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${tenant}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    tenants.push(tenant);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${tenant}::uuid, ${m.userId}, 'member')`.execute(db);
    const res = await app.request('/api/me/api-keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-slug': slug,
        cookie: m.cookie,
        ...(await m.stepUp!('api_key.create')),
      },
      body: JSON.stringify({
        name: NAME,
        scopes: [{ collection: 'mak_none', actions: ['read'] }],
        expires_at: inDays(7),
      }),
    });
    expect(res.status).toBe(200);
    const { key, tenant_id } = (await res.json()) as { key: string; tenant_id: string };
    expect(tenant_id).toBe(tenant);
    const inTenant = await app.request('/api/api-keys/self', {
      headers: { 'X-API-Key': key, 'x-tenant-slug': slug },
    });
    expect(inTenant.status).toBe(200);
    expect((await self(key)).status).toBe(401);
  });

  it("counts a member's keys against one bucket, the member's", async () => {
    await setSwitch(true);
    const m = await member();
    const a = ((await (await create(m)).json()) as { key: string }).key;
    const b = ((await (await create(m)).json()) as { key: string }).key;
    const row = await sql<{ member_issued: boolean }>`
      SELECT member_issued FROM zv_api_keys WHERE created_by = ${m.userId} LIMIT 1`.execute(db);
    expect(row.rows[0]?.member_issued).toBe(true);

    const savedEnv = process.env.NODE_ENV;
    const savedProxy = process.env.TRUSTED_PROXY;
    process.env.NODE_ENV = 'development'; // the limiter bypasses itself under 'test'
    process.env.TRUSTED_PROXY = 'true';
    await sql`UPDATE zv_rate_limit_configs SET max_requests = 3 WHERE key_prefix = 'api'`.execute(
      db,
    );
    invalidateRateLimitCache('api');
    try {
      // A fresh address per request: only the member ties them together.
      let ip = 0;
      const seen: number[] = [];
      for (const key of [a, a, b, b])
        seen.push((await self(key, `198.51.100.${200 + ++ip}`)).status);
      expect(seen).toEqual([200, 200, 200, 429]);
    } finally {
      await sql`UPDATE zv_rate_limit_configs SET max_requests = 200 WHERE key_prefix = 'api'`.execute(
        db,
      );
      invalidateRateLimitCache('api');
      process.env.NODE_ENV = savedEnv;
      if (savedProxy === undefined) delete process.env.TRUSTED_PROXY;
      else process.env.TRUSTED_PROXY = savedProxy;
    }
  });
});
