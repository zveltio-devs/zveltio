/**
 * A collection cannot take the name of an engine Casbin object
 * (`ENGINE_CASBIN_OBJECTS`).
 *
 * Collections and the engine's objects share one namespace: the policy's
 * object column. A collection called `data` would be read by every
 * `data:view_all` grant on the instance, and its drop would take them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLE = `hcasbin_obj_role_${Date.now()}`;
const FIELDS = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];

const grantRows = async (db: Database, obj: string) =>
  Number(
    (
      await sql<{ n: string }>`
        SELECT count(*)::text AS n FROM zvd_permissions WHERE ptype = 'p' AND v0 = ${ROLE} AND v2 = ${obj}`.execute(
        db,
      )
    ).rows[0]?.n ?? 0,
  );

d('collection names and the engine Casbin objects', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    await (await getEnforcer()).addPolicy(ROLE, '*', 'data', 'view_all');
  });

  afterAll(async () => {
    if (!db) return;
    await (await getEnforcer()).removeFilteredPolicy(0, ROLE);
    await sql.raw('DROP TABLE IF EXISTS "zvd_data" CASCADE').execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', 'data').execute();
  });

  it('refuses a collection named after the engine object `data`', async () => {
    await expect(
      DDLManager.createCollection(db, { name: 'data', fields: FIELDS } as never),
    ).rejects.toThrow(/reserved/);
    expect(await DDLManager.tableExists(db, 'data')).toBe(false);
    expect(await grantRows(db, 'data')).toBe(1);
  });

  it('refuses it on the route before any metadata is written', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ name: 'data', fields: FIELDS }),
    });
    expect(res.status).toBe(409);
    expect(await DDLManager.getCollection(db, 'data')).toBeNull();
  });
});
