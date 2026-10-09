/**
 * A collection cannot take the name of a Casbin object that is not one, and
 * dropping a collection never takes such an object's rules with it.
 *
 * Collections and the other Casbin objects share one namespace: the policy's
 * object column. `dropCollection` deleted every rule naming the collection, so
 * creating and then dropping a collection called `data` wiped every
 * `data:view_all` grant on the instance — and the same for any resource an
 * installed extension guards (`permissionGate(ctx, 'invoices')`).
 *
 * The names come from where they are asked: the engine's own objects
 * (`ENGINE_CASBIN_OBJECTS`) and each installed extension's `manifest.resources`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLE = `hcasbin_obj_role_${Date.now()}`;
const EXT = `test/casbin-obj-${Date.now()}`;
const EXT_RESOURCE = `hext_res_${Date.now()}`;
const PFX = `htpl${Date.now()}`;
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

d('collection names and the Casbin objects that are not collections', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  const extDir = join(tmpdir(), `zv-casbin-obj-${Date.now()}`);
  const prevExtDir = process.env.EXTENSIONS_DIR;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    const e = await getEnforcer();
    await e.addPolicy(ROLE, '*', 'data', 'view_all');
    await e.addPolicy(ROLE, '*', EXT_RESOURCE, 'read');

    mkdirSync(join(extDir, EXT), { recursive: true });
    writeFileSync(
      join(extDir, EXT, 'manifest.json'),
      JSON.stringify({ name: EXT, resources: [EXT_RESOURCE, `${PFX}_hd_tickets`] }),
    );
    process.env.EXTENSIONS_DIR = extDir;
    await sql`INSERT INTO zv_extension_registry (name, display_name, is_installed)
              VALUES (${EXT}, 'casbin obj', true)`.execute(db);
  });

  afterAll(async () => {
    if (prevExtDir === undefined) delete process.env.EXTENSIONS_DIR;
    else process.env.EXTENSIONS_DIR = prevExtDir;
    rmSync(extDir, { recursive: true, force: true });
    if (!db) return;
    await sql`DELETE FROM zv_extension_registry WHERE name = ${EXT}`.execute(db);
    const e = await getEnforcer();
    await e.removeFilteredPolicy(0, ROLE);
    const tpl = await sql<{ name: string }>`
      SELECT name FROM zvd_collections WHERE name LIKE ${`${PFX}_%`}`.execute(db);
    for (const name of ['data', EXT_RESOURCE, ...tpl.rows.map((r) => r.name)]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', name).execute();
    }
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

  it("refuses a collection named after an installed extension's resource", async () => {
    await expect(
      DDLManager.createCollection(db, { name: EXT_RESOURCE, fields: FIELDS } as never),
    ).rejects.toThrow(/reserved/);
    expect(await grantRows(db, EXT_RESOURCE)).toBe(1);
  });

  it('refuses a template install that would create one, before writing anything', async () => {
    const res = await app.request('/api/templates/helpdesk/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ prefix: PFX }),
    });
    expect(res.status, await res.clone().text()).toBe(409);
    const rows = await sql`SELECT 1 FROM zvd_collections WHERE name LIKE ${`${PFX}_%`}`.execute(db);
    expect(rows.rows).toEqual([]);
  }, 60_000);

  it("dropping a collection that already shares such a name keeps the object's rules", async () => {
    // A collection made before the reservation existed, or adopted by the
    // extension that declares the name: the drop must not take the grants.
    await sql.raw(`CREATE TABLE "zvd_data" (id uuid PRIMARY KEY)`).execute(db);
    await DDLManager.registerMetadata(db, { name: 'data', fields: [] } as never);

    await DDLManager.dropCollection(db, 'data');

    expect(await DDLManager.tableExists(db, 'data')).toBe(false);
    expect(await grantRows(db, 'data')).toBe(1);
    expect(await (await getEnforcer()).hasPolicy(ROLE, '*', 'data', 'view_all')).toBe(true);
  });
});
