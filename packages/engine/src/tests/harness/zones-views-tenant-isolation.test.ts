/**
 * Phase C — zones/pages/views tenant isolation. zvd_zones/pages/views already
 * carried tenant_id but routes/zones.ts queried by slug/id/zone_id with NO
 * tenant filter, so:
 *   - list showed every tenant's zones/views,
 *   - GET/PUT/DELETE zone-by-slug + view-by-id reached across tenants, and
 *   - the public render path resolved each view's records from zvd_<collection>
 *     with no tenant scope → served another tenant's business data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const STAMP = Date.now();
const FOREIGN_ZONE_ID = '00000000-0000-4000-8000-0000000000f1';
const FOREIGN_ZONE_SLUG = `ziso-foreign-${STAMP}`;
const FOREIGN_VIEW_ID = '00000000-0000-4000-8000-0000000000f2';
const MY_SLUG = `ziso-mine-${STAMP}`;
const COLLECTION = `ziso_things_${STAMP}`;

d('zones/views tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myZoneId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // zvd_zones.tenant_id has a FK to zv_tenants — the other tenant must exist.
    await db
      .insertInto('zv_tenants')
      .values({ id: OTHER_TENANT, slug: `ziso-t-${STAMP}`, name: 'ziso-foreign-tenant' } as never)
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // A zone + a view belonging to ANOTHER tenant, inserted directly.
    await db
      .insertInto('zvd_zones')
      .values({
        id: FOREIGN_ZONE_ID,
        name: `foreign-${STAMP}`,
        slug: FOREIGN_ZONE_SLUG,
        is_active: true,
        access_roles: [] as unknown as string[],
        base_path: `/${FOREIGN_ZONE_SLUG}`,
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();
    await db
      .insertInto('zvd_views')
      .values({
        id: FOREIGN_VIEW_ID,
        name: `foreign-view-${STAMP}`,
        collection: COLLECTION,
        view_type: 'table',
        fields: JSON.stringify([]),
        filters: JSON.stringify([]),
        config: JSON.stringify({}),
        tenant_id: OTHER_TENANT,
      } as never)
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [FOREIGN_ZONE_ID, myZoneId].filter(Boolean)) {
      await db
        .deleteFrom('zvd_pages')
        .where('zone_id', '=', id)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zvd_zones')
        .where('id', '=', id)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_views')
      .where('id', '=', FOREIGN_VIEW_ID)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zvd_views')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zv_tenants')
      .where('id', '=', OTHER_TENANT)
      .execute()
      .catch(() => {});
  });

  // ── Zone config IDOR ──────────────────────────────────────────────────────

  it('list + create: hides the other tenant’s zone', async () => {
    const create = await app.request('/api/zones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `mine-${STAMP}`, slug: MY_SLUG, is_active: true }),
    });
    expect(create.status).toBe(201);
    myZoneId = ((await create.json()) as { zone: { id: string } }).zone.id;

    const list = await app.request('/api/zones', { headers: { cookie } });
    const slugs = ((await list.json()) as { zones: { slug: string }[] }).zones.map((z) => z.slug);
    expect(slugs).toContain(MY_SLUG);
    expect(slugs).not.toContain(FOREIGN_ZONE_SLUG);
  });

  it('permission resources do not expose another tenant’s zones', async () => {
    const res = await app.request('/api/admin/resources', { headers: { cookie } });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { resources: { name: string; type: string }[] }).resources
      .filter((r) => r.type === 'zone')
      .map((r) => r.name);
    expect(names).not.toContain(FOREIGN_ZONE_SLUG);
  });

  it('cross-tenant: GET/PUT/DELETE another tenant’s zone → 404, untouched', async () => {
    expect(
      (await app.request(`/api/zones/${FOREIGN_ZONE_SLUG}`, { headers: { cookie } })).status,
    ).toBe(404);

    const put = await app.request(`/api/zones/${FOREIGN_ZONE_SLUG}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'hijacked' }),
    });
    expect(put.status).toBe(404);

    await app.request(`/api/zones/${FOREIGN_ZONE_SLUG}`, { method: 'DELETE', headers: { cookie } });
    const still = await db
      .selectFrom('zvd_zones')
      .select('name')
      .where('id', '=', FOREIGN_ZONE_ID)
      .executeTakeFirst();
    expect(still?.name).toBe(`foreign-${STAMP}`); // untouched + still present
  });

  // ── View config IDOR ──────────────────────────────────────────────────────

  it('cross-tenant: view list hides + GET/DELETE another tenant’s view → 404, untouched', async () => {
    const list = await app.request('/api/views', { headers: { cookie } });
    const ids = ((await list.json()) as { views: { id: string }[] }).views.map((v) => v.id);
    expect(ids).not.toContain(FOREIGN_VIEW_ID);

    expect(
      (await app.request(`/api/views/${FOREIGN_VIEW_ID}`, { headers: { cookie } })).status,
    ).toBe(404);

    await app.request(`/api/views/${FOREIGN_VIEW_ID}`, { method: 'DELETE', headers: { cookie } });
    const still = await db
      .selectFrom('zvd_views')
      .select('id')
      .where('id', '=', FOREIGN_VIEW_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_VIEW_ID);
  });

  // ── Render data leak (P0) ─────────────────────────────────────────────────

  it('render: a page view does NOT serve another tenant’s collection records', async () => {
    // A collection with one record per tenant.
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await sql
      .raw(
        `INSERT INTO "zvd_${COLLECTION}" (title, tenant_id) VALUES ('mine-row', '00000000-0000-0000-0000-000000000001'), ('foreign-row', '${OTHER_TENANT}')`,
      )
      .execute(db);

    // My zone → page → view(collection) → page_view, all as the default tenant.
    const myView = await app.request('/api/views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `v-${STAMP}`, collection: COLLECTION, view_type: 'table' }),
    });
    const viewId = ((await myView.json()) as { view: { id: string } }).view.id;

    await app.request(`/api/zones/${MY_SLUG}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Home', slug: 'home', is_active: true, auth_required: false }),
    });
    await app.request(`/api/zones/${MY_SLUG}/pages/home/views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ view_id: viewId }),
    });

    const render = await app.request(`/api/zones/${MY_SLUG}/render/home`, { headers: { cookie } });
    expect(render.status).toBe(200);
    const body = (await render.json()) as {
      views: { data: { records: { title: string }[] } }[];
    };
    const titles = body.views.flatMap((v) => v.data.records.map((r) => r.title));
    expect(titles).toContain('mine-row');
    expect(titles).not.toContain('foreign-row'); // the leak is closed
  });
});
