/**
 * A matrix save made from a stale load is refused, not applied.
 *
 * The Studio matrix posts every global rule it loaded, and
 * `POST /api/admin/permissions/bulk` makes each role's global rules exactly that
 * set. A grant made after the screen loaded — by another admin, the policies
 * API, an extension action grant — was not in the posted set, so the save
 * silently revoked it. `GET /permissions` now returns a `version` of the rules
 * it shows; the save carries it back and is refused with 409 when the rules
 * changed since.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { reconcilePolicies } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ROLE = `pmlu_role_${tag}`;

type Matrix = {
  permissions: Array<{ role_id: string; resource: string; action: string }>;
  version: string;
};

d('the matrix save from a stale load', () => {
  let app: Hono;
  let db: Database;
  let god: string;

  const json = { 'Content-Type': 'application/json' };
  const load = async () =>
    (await (
      await app.request('/api/admin/permissions', { headers: { cookie: god } })
    ).json()) as Matrix;
  const save = (body: unknown) =>
    app.request('/api/admin/permissions/bulk', {
      method: 'POST',
      headers: { ...json, cookie: god },
      body: JSON.stringify(body),
    });
  const granted = async (resource: string) =>
    (
      await sql`SELECT 1 FROM zvd_permissions WHERE ptype = 'p' AND v0 = ${ROLE}
                AND v1 = '*' AND v2 = ${resource} AND v3 = 'read'`.execute(db)
    ).rows.length > 0;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const res = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { ...json, cookie: god },
      body: JSON.stringify({ name: ROLE }),
    });
    expect(res.status).toBeLessThan(300);
    await reconcilePolicies();
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE}`.execute(db);
    await db.deleteFrom('zv_roles').where('name', '=', ROLE).execute();
    await reconcilePolicies();
  });

  it('keeps a grant made after the matrix loaded', async () => {
    const stale = await load();
    expect(stale.version).toMatch(/^[0-9a-f]{64}$/);

    const resource = `pmlu_late_${tag}`;
    const grant = await app.request('/api/permissions/policies', {
      method: 'POST',
      headers: { ...json, cookie: god },
      body: JSON.stringify({ subject: ROLE, resource, action: 'read' }),
    });
    expect(grant.status).toBe(200);

    const res = await save(stale);
    expect(res.status).toBe(409);
    expect(await granted(resource)).toBe(true);

    // Reloaded, the same save goes through and keeps the grant it now shows.
    expect((await save(await load())).status).toBe(200);
    expect(await granted(resource)).toBe(true);
  });

  it('refuses a save that carries no version', async () => {
    const { permissions } = await load();
    expect((await save({ permissions })).status).toBe(400);
  });
});
