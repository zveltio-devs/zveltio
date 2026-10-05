/**
 * Phase C — insights dashboards tenant isolation. Regression: zv_dashboards had
 * no tenant_id and routes/insights.ts listed `WHERE is_public = true OR ...`, so a
 * PUBLIC dashboard leaked to authenticated users of EVERY tenant, and by-id
 * read/delete/share handlers reached dashboards across tenants.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000da';
const FOREIGN_PANEL = '00000000-0000-4000-8000-0000000000db';
const FOREIGN_SHARE = '00000000-0000-4000-8000-0000000000dc';
const FOREIGN_QUERY = '00000000-0000-4000-8000-0000000000dd';
const FOREIGN_SQL = `SELECT 'foreign-${Date.now()}' AS mark`;
const STAMP = Date.now();

d('dashboards tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myId = '';
  let userId = '';

  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/insights${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A PUBLIC dashboard belonging to ANOTHER tenant, inserted directly.
    await db
      .insertInto('zv_dashboards')
      .values({
        id: FOREIGN_ID,
        name: `foreign-public-${STAMP}`,
        is_public: true,
        tenant_id: OTHER_TENANT,
      })
      .execute();

    // Children of that dashboard, and a saved query, of the same tenant.
    const session = await app.request('/api/auth/get-session', { headers: { cookie } });
    userId = ((await session.json()) as { user: { id: string } }).user.id;
    await db
      .insertInto('zv_panels')
      .values({ id: FOREIGN_PANEL, dashboard_id: FOREIGN_ID, title: 'foreign', query: FOREIGN_SQL })
      .execute();
    await db
      .insertInto('zvd_dashboard_shares')
      .values({
        id: FOREIGN_SHARE,
        dashboard_id: FOREIGN_ID,
        shared_with_role: 'foreign-role',
        created_by: userId,
      })
      .execute();
    await db
      .insertInto('zvd_insight_saved_queries')
      .values({
        id: FOREIGN_QUERY,
        name: 'foreign',
        query: FOREIGN_SQL,
        is_public: true,
        created_by: userId,
        tenant_id: OTHER_TENANT,
      })
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_insight_saved_queries WHERE id = ${FOREIGN_QUERY} OR created_by = ${userId}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_dashboard_subscriptions WHERE user_id = ${userId}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_dashboard_shares WHERE dashboard_id = ${FOREIGN_ID}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_panels WHERE dashboard_id = ${FOREIGN_ID}`.execute(db).catch(() => {});
    await db
      .deleteFrom('zv_dashboards')
      .where('id', '=', FOREIGN_ID)
      .execute()
      .catch(() => {});
    if (myId)
      await db
        .deleteFrom('zv_dashboards')
        .where('id', '=', myId)
        .execute()
        .catch(() => {});
  });

  it('single-tenant: create + list works and hides the other tenant’s public dashboard', async () => {
    const create = await app.request('/api/insights/dashboards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `mine-${STAMP}`, is_public: true }),
    });
    expect(create.status).toBe(201);
    myId = ((await create.json()) as { dashboard: { id: string } }).dashboard.id;

    const list = await app.request('/api/insights/dashboards', { headers: { cookie } });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { dashboards: { id: string }[] }).dashboards.map(
      (x) => x.id,
    );
    expect(ids).toContain(myId);
    // the other tenant's PUBLIC dashboard must NOT leak into this tenant's list
    expect(ids).not.toContain(FOREIGN_ID);
  });

  it('cross-tenant: GET /dashboards/:id of another tenant’s dashboard → 404', async () => {
    const res = await app.request(`/api/insights/dashboards/${FOREIGN_ID}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  const foreignPanel = () =>
    db.selectFrom('zv_panels').select('query').where('id', '=', FOREIGN_PANEL).executeTakeFirst();
  const foreignShares = () =>
    db
      .selectFrom('zvd_dashboard_shares')
      .select('id')
      .where('dashboard_id', '=', FOREIGN_ID)
      .execute();
  const foreignQuery = () =>
    db
      .selectFrom('zvd_insight_saved_queries')
      .select(['name', 'query'])
      .where('id', '=', FOREIGN_QUERY)
      .executeTakeFirst();

  it('cross-tenant: shares of another tenant’s dashboard are not listed, added or removed', async () => {
    expect((await send('GET', `/dashboards/${FOREIGN_ID}/shares`)).status).toBe(404);
    const add = await send('POST', `/dashboards/${FOREIGN_ID}/shares`, {
      shared_with_user_id: userId,
    });
    expect(add.status).toBe(404);
    // Directly, and through a dashboard of this tenant: the share id is matched to its dashboard.
    for (const dash of [FOREIGN_ID, myId]) {
      expect((await send('DELETE', `/dashboards/${dash}/shares/${FOREIGN_SHARE}`)).status).toBe(
        404,
      );
    }
    expect((await foreignShares()).map((r) => r.id)).toEqual([FOREIGN_SHARE]);
  });

  it('cross-tenant: panels of another tenant’s dashboard are not added, changed, deleted or run', async () => {
    const add = await send('POST', `/dashboards/${FOREIGN_ID}/panels`, {
      title: 'planted',
      query: 'SELECT 1',
    });
    expect(add.status).toBe(404);
    const patch = await send('PATCH', `/panels/${FOREIGN_PANEL}`, { query: 'SELECT 2' });
    expect(patch.status).toBe(404);
    expect((await foreignPanel())?.query).toBe(FOREIGN_SQL);
    expect((await send('DELETE', `/panels/${FOREIGN_PANEL}`)).status).toBe(404);
    expect(await foreignPanel()).toBeDefined();
    const run = await send('POST', `/panels/${FOREIGN_PANEL}/execute`);
    expect(run.status).toBe(404);
    expect(await run.text()).not.toContain('foreign-');
    const panels = await db
      .selectFrom('zv_panels')
      .select('id')
      .where('dashboard_id', '=', FOREIGN_ID)
      .execute();
    expect(panels.map((r) => r.id)).toEqual([FOREIGN_PANEL]);
  });

  it('saved queries: a new one lands in this tenant; another tenant’s is not changed, deleted or run', async () => {
    const mine = await send('POST', '/saved-queries', { name: `mine-${STAMP}`, query: 'SELECT 1' });
    expect(mine.status).toBe(201);
    const mineId = ((await mine.json()) as { query: { id: string } }).query.id;
    const row = await db
      .selectFrom('zvd_insight_saved_queries')
      .select('tenant_id')
      .where('id', '=', mineId)
      .executeTakeFirst();
    const dash = await db
      .selectFrom('zv_dashboards')
      .select('tenant_id')
      .where('id', '=', myId)
      .executeTakeFirst();
    expect(row?.tenant_id).toBe(dash?.tenant_id as string);
    expect(row?.tenant_id).not.toBe(OTHER_TENANT);

    const patch = await send('PATCH', `/saved-queries/${FOREIGN_QUERY}`, { name: 'hijacked' });
    expect(patch.status).toBe(404);
    expect((await send('DELETE', `/saved-queries/${FOREIGN_QUERY}`)).status).toBe(404);
    const run = await send('POST', `/saved-queries/${FOREIGN_QUERY}/execute`);
    expect(run.status).toBe(404);
    expect(await run.text()).not.toContain('foreign-');
    expect(await foreignQuery()).toEqual({ name: 'foreign', query: FOREIGN_SQL });
  });

  it('cross-tenant: no subscription to another tenant’s dashboard', async () => {
    const res = await send('POST', '/subscriptions', {
      dashboard_id: FOREIGN_ID,
      email: 'probe@test.local',
    });
    expect(res.status).toBe(404);
    const subs = await db
      .selectFrom('zvd_dashboard_subscriptions')
      .select('id')
      .where('dashboard_id', '=', FOREIGN_ID)
      .execute();
    expect(subs).toEqual([]);
  });

  it('cross-tenant: DELETE /dashboards/:id does not remove another tenant’s dashboard', async () => {
    const res = await app.request(`/api/insights/dashboards/${FOREIGN_ID}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    const still = await db
      .selectFrom('zv_dashboards')
      .select('id')
      .where('id', '=', FOREIGN_ID)
      .executeTakeFirst();
    expect(still?.id).toBe(FOREIGN_ID); // untouched
  });
});
