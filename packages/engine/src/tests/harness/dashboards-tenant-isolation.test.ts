/**
 * Phase C — insights dashboards tenant isolation. Regression: zv_dashboards had
 * no tenant_id and routes/insights.ts listed `WHERE is_public = true OR ...`, so a
 * PUBLIC dashboard leaked to authenticated users of EVERY tenant, and by-id
 * read/delete/share handlers reached dashboards across tenants.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const FOREIGN_ID = '00000000-0000-4000-8000-0000000000da';
const STAMP = Date.now();

d('dashboards tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let myId = '';

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
  });

  afterAll(async () => {
    if (!db) return;
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
