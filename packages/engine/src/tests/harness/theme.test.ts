/**
 * Themes are data (ADR 0007): the instance's in `zv_settings.theme`, a tenant's
 * in `zv_tenants.settings.theme`, served tenant-over-instance by
 * `/api/settings/public` to every page before anyone signs in. Each value lands
 * in a style attribute, so a write holding anything but a colour, a length or a
 * known name is refused.
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
import { themeSchema } from '../../lib/theme.js';

const d = harnessAvailable() ? describe : describe.skip;

const instance = { scheme: 'light', colors: { primary: '#069494' }, radius: { box: '0.5rem' } };
const own = { scheme: 'dark', colors: { primary: 'oklch(62% 0.2 255)' }, font: 'serif' };
const hostile = [
  { colors: { primary: 'red;background:url(https://x)' } },
  { colors: { primary: '#fff', unknown: '#000' } },
  { radius: { box: '1rem}body{display:none' } },
  { font: 'Comic Sans' },
  { scheme: 'dark', extra: 1 },
];

d('theme as data', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const id = crypto.randomUUID();
  const slug = `thm-${id.slice(0, 8)}`;
  let saved: unknown;

  const req = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'x-tenant-slug': slug },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const publicTheme = async (tenant: string | null) =>
    (
      (await (
        await app.request('/api/settings/public', {
          headers: tenant ? { 'x-tenant-slug': tenant } : {},
        })
      ).json()) as { theme: unknown }
    ).theme;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    saved = (
      await sql<{ value: unknown }>`SELECT value FROM zv_settings WHERE key = 'theme'`.execute(db)
    ).rows[0]?.value;
    await sql`DELETE FROM zv_settings WHERE key = 'theme'`.execute(db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status, settings)
              VALUES (${id}::uuid, ${slug}, ${slug}, 'active', '{"keep":1}'::jsonb)`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_tenants WHERE id = ${id}::uuid`.execute(db);
    await sql`DELETE FROM zv_settings WHERE key = 'theme'`.execute(db);
    if (saved !== undefined)
      await sql`INSERT INTO zv_settings (key, value) VALUES ('theme', ${JSON.stringify(saved)}::text::jsonb)`.execute(
        db,
      );
  });

  it('accepts tokens and refuses anything that could leave its declaration', () => {
    expect(themeSchema.safeParse(instance).success).toBe(true);
    expect(themeSchema.safeParse(own).success).toBe(true);
    for (const t of hostile) expect(themeSchema.safeParse(t).success).toBe(false);
  });

  it('stores the instance theme only when valid, on both write paths', async () => {
    for (const t of hostile) {
      expect((await req('PUT', '/api/settings/theme', god, { value: t })).status).toBe(400);
      expect((await req('PATCH', '/api/settings/bulk', god, { theme: t })).status).toBe(400);
    }
    expect(await publicTheme(null)).toBeNull();

    expect((await req('PUT', '/api/settings/theme', god, { value: instance })).status).toBe(200);
    // Public without `is_public`: every page needs it before sign-in.
    expect(await publicTheme(null)).toEqual(instance);
  });

  it('lets the tenant admin set and clear its own theme, over the instance’s', async () => {
    expect(await publicTheme(slug)).toEqual(instance);
    for (const t of hostile)
      expect((await req('PUT', '/api/tenants/current/theme', god, { theme: t })).status).toBe(400);

    const put = await req('PUT', '/api/tenants/current/theme', god, { theme: own });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ theme: own, effective: own });
    const row = (
      await sql<{
        settings: Record<string, unknown>;
      }>`SELECT settings FROM zv_tenants WHERE id = ${id}::uuid`.execute(db)
    ).rows[0];
    expect(row.settings).toEqual({ keep: 1, theme: own });
    expect(await publicTheme(slug)).toEqual(own);
    expect(await publicTheme(null)).toEqual(instance);

    const cleared = await req('PUT', '/api/tenants/current/theme', god, { theme: null });
    expect(await cleared.json()).toEqual({ theme: null, effective: instance });
    expect(await (await req('GET', '/api/tenants/current/theme', god)).json()).toEqual({
      theme: null,
      effective: instance,
    });
  });

  it('refuses a caller who is not the tenant’s admin', async () => {
    const { cookie, userId } = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id) VALUES (${id}::uuid, ${userId})`.execute(
      db,
    );
    try {
      expect((await req('GET', '/api/tenants/current/theme', cookie)).status).toBe(403);
      expect((await req('PUT', '/api/tenants/current/theme', cookie, { theme: own })).status).toBe(
        403,
      );
      expect((await req('PUT', '/api/settings/theme', cookie, { value: own })).status).toBe(403);
    } finally {
      await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${id}::uuid`.execute(db);
    }
  });
});
