/**
 * A tenant's own time zone: set by its admin, served as the zone Studio formats
 * and takes "today" in, and resolved tenant → instance → UTC for extensions
 * (`ActionHost.timezone`, `JobHost.timezone`).
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
import { effectiveTimeZone, isTimeZone } from '../../lib/tenancy/timezone.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

d('tenant time zone', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const id = crypto.randomUUID();
  const slug = `ttz-${id.slice(0, 8)}`;
  let savedInstance: unknown;

  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'x-tenant-slug': slug },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const setInstance = (tz: string | null) =>
    tz === null
      ? sql`DELETE FROM zv_settings WHERE key = 'timezone'`.execute(db)
      : sql`INSERT INTO zv_settings (key, value, is_public) VALUES ('timezone', to_jsonb(${tz}::text), true)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_public = true`.execute(db);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    savedInstance = (
      await sql<{ value: unknown }>`SELECT value FROM zv_settings WHERE key = 'timezone'`.execute(
        db,
      )
    ).rows[0]?.value;
    await sql`INSERT INTO zv_tenants (id, slug, name, status, settings)
              VALUES (${id}::uuid, ${slug}, ${slug}, 'active', '{"keep":1}'::jsonb)`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_tenants WHERE id = ${id}::uuid`.execute(db);
    if (savedInstance === undefined) await setInstance(null);
    else
      await sql`UPDATE zv_settings SET value = ${JSON.stringify(savedInstance)}::jsonb WHERE key = 'timezone'`.execute(
        db,
      );
  });

  it('knows a zone from a typo', () => {
    expect(isTimeZone('Europe/Bucharest')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Europe/Bucharestt')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(null)).toBe(false);
  });

  it('resolves tenant, then instance, then UTC — skipping a value it does not know', async () => {
    await setInstance(null);
    expect(await effectiveTimeZone(db, id)).toBe('UTC');
    await setInstance('Europe/Lisbon');
    expect(await effectiveTimeZone(db, id)).toBe('Europe/Lisbon');
    expect(await effectiveTimeZone(db, null)).toBe('Europe/Lisbon');
    await sql`UPDATE zv_tenants SET settings = settings || '{"timezone":"Nowhere/Here"}' WHERE id = ${id}::uuid`.execute(
      db,
    );
    expect(await effectiveTimeZone(db, id)).toBe('Europe/Lisbon');
  });

  it('lets the tenant admin set and clear its own zone, one key, nothing else', async () => {
    await setInstance('Europe/Lisbon');
    const put = await req('PUT', '/api/tenants/current/timezone', god, {
      timezone: 'Europe/Bucharest',
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      timezone: 'Europe/Bucharest',
      effective: 'Europe/Bucharest',
    });
    const row = (
      await sql<{
        settings: Record<string, unknown>;
      }>`SELECT settings FROM zv_tenants WHERE id = ${id}::uuid`.execute(db)
    ).rows[0];
    expect(row.settings).toEqual({ keep: 1, timezone: 'Europe/Bucharest' });

    // Served as the zone Studio formats and takes "today" in.
    const pub = await req('GET', '/api/settings/public', god);
    expect(((await pub.json()) as { timezone?: string }).timezone).toBe('Europe/Bucharest');

    expect(
      (await req('PUT', '/api/tenants/current/timezone', god, { timezone: 'Mars/Olympus' })).status,
    ).toBe(400);

    const cleared = await req('PUT', '/api/tenants/current/timezone', god, { timezone: null });
    expect(await cleared.json()).toEqual({ timezone: null, effective: 'Europe/Lisbon' });
    const get = await req('GET', '/api/tenants/current/timezone', god);
    expect(await get.json()).toEqual({ timezone: null, effective: 'Europe/Lisbon' });
  });

  it('refuses a caller who is not the tenant’s admin', async () => {
    const { cookie, userId } = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id) VALUES (${id}::uuid, ${userId})`.execute(
      db,
    );
    try {
      expect((await req('GET', '/api/tenants/current/timezone', cookie)).status).toBe(403);
      expect(
        (await req('PUT', '/api/tenants/current/timezone', cookie, { timezone: 'UTC' })).status,
      ).toBe(403);
    } finally {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${id}::uuid`.execute(db);
    }
  });
});

d('tenant time zone, across tenants', () => {
  let app: Hono;
  let db: Database;
  const mk = () => {
    const id = crypto.randomUUID();
    return { id, slug: `ttx-${id.slice(0, 8)}` };
  };
  const a = mk();
  const b = mk();
  const users: string[] = [];

  const call = (method: string, slug: string | null, cookie?: string, body?: unknown) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (slug) headers['x-tenant-slug'] = slug;
    return app.request(
      method === 'PUBLIC' ? '/api/settings/public' : '/api/tenants/current/timezone',
      {
        method: method === 'PUBLIC' ? 'GET' : method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  };
  const zoneOf = async (id: string) =>
    (
      await sql<{
        tz: string | null;
      }>`SELECT settings->>'timezone' AS tz FROM zv_tenants WHERE id = ${id}::uuid`.execute(db)
    ).rows[0]?.tz ?? null;

  /** A member of `memberOf`, holding `tenant_admin` in `adminOf`. */
  async function adminOf(adminIn: string, memberOf: string[]): Promise<string> {
    const { cookie, userId } = await createMemberSession(app, db);
    users.push(userId);
    for (const t of memberOf)
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id) VALUES (${t}::uuid, ${userId})`.execute(
        db,
      );
    await (await getEnforcer()).addRoleForUser(userId, 'tenant_admin', adminIn);
    await invalidateUserPermCache(userId);
    return cookie;
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    for (const t of [a, b])
      await sql`INSERT INTO zv_tenants (id, slug, name, status, settings)
                VALUES (${t.id}::uuid, ${t.slug}, ${t.slug}, 'active', '{}'::jsonb)`.execute(db);
    await sql`UPDATE zv_tenants SET settings = '{"timezone":"Asia/Tokyo"}' WHERE id = ${b.id}::uuid`.execute(
      db,
    );
  });

  afterAll(async () => {
    const e = await getEnforcer();
    for (const u of users)
      for (const t of [a, b]) await e.deleteRoleForUser(u, 'tenant_admin', t.id);
    for (const t of [a, b]) {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${t.id}::uuid`.execute(db);
      await sql`DELETE FROM zv_tenants WHERE id = ${t.id}::uuid`.execute(db);
    }
  });

  it("A's admin sets A's zone, and cannot read or write B's by naming B", async () => {
    const onlyA = await adminOf(a.id, [a.id]);
    const alsoInB = await adminOf(a.id, [a.id, b.id]);
    // Positive control: the 403s below are about the tenant, not the caller.
    expect((await call('PUT', a.slug, onlyA, { timezone: 'Europe/Bucharest' })).status).toBe(200);
    expect(await zoneOf(a.id)).toBe('Europe/Bucharest');
    for (const cookie of [onlyA, alsoInB]) {
      expect((await call('GET', b.slug, cookie)).status).toBe(403);
      expect((await call('PUT', b.slug, cookie, { timezone: 'UTC' })).status).toBe(403);
      // No header resolves the default tenant, where A's admin is nobody.
      expect((await call('PUT', null, cookie, { timezone: 'UTC' })).status).toBe(403);
    }
    expect(await zoneOf(b.id)).toBe('Asia/Tokyo');
    expect(await zoneOf(a.id)).toBe('Europe/Bucharest');
  });

  it('the public settings answer an unknown slug as before, not with a 500', async () => {
    expect((await call('PUBLIC', `nope-${a.id}`)).status).toBe(404);
    const pub = await call('PUBLIC', b.slug);
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { timezone?: string }).timezone).toBe('Asia/Tokyo');
  });
});
