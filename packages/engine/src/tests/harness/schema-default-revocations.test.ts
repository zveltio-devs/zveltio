/**
 * A revoked default grant travels with the schema files.
 *
 * `roles.json` left the defaults out entirely, revoked ones included, so an
 * operator who took `tenant_member` read away on one instance exported a file
 * that said nothing about it, and applying that file elsewhere kept the access.
 * The role's `revokedDefaults` now carries it: export lists it, plan shows it,
 * apply revokes it through the enforcer — before the resource exists, too — and
 * a file that no longer lists it restores the default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import { materializeDefaultGrants } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLL = `sdr_${tag}`;
const EXT_RES = `sdr-ext-${tag}`;

d('schema files carry revoked default grants', () => {
  let app: Hono;
  let db: Database;
  let god: string;

  const request = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const policy = (method: 'POST' | 'DELETE', resource: string, action: string) =>
    request(method, '/api/permissions/policies', { subject: 'tenant_member', resource, action });
  const pull = async () =>
    (
      (await (
        await app.request('/api/admin/schema/export', { headers: { cookie: god } })
      ).json()) as {
        files: Record<string, string>;
      }
    ).files;
  const steps = async (files: unknown) =>
    (
      (await (await request('POST', '/api/admin/schema/plan', { files })).json()) as {
        steps: { change: string; target: string; action: string }[];
      }
    ).steps.map((s) => `${s.change} ${s.target} ${s.action}`);
  const apply = (files: unknown) => request('POST', '/api/admin/schema/apply', { files });
  const state = async (resource: string, action: string) => {
    const held = await sql`SELECT 1 FROM zvd_permissions WHERE ptype = 'p' AND v0 = 'tenant_member'
                             AND v1 = '*' AND v2 = ${resource} AND v3 = ${action}`.execute(db);
    const revoked = await sql`SELECT 1 FROM zv_default_grant_revocations
       WHERE role = 'tenant_member' AND resource = ${resource} AND action = ${action}`.execute(db);
    return { held: held.rows.length > 0, revoked: revoked.rows.length > 0 };
  };
  const forget = async () => {
    await sql`DELETE FROM zvd_permissions WHERE v2 IN (${COLL}, ${EXT_RES})`.execute(db);
    await sql`DELETE FROM zv_default_grant_revocations WHERE resource IN (${COLL}, ${EXT_RES})`.execute(
      db,
    );
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      displayName: 'Probe',
      fields: [{ name: 'title', type: 'text' }],
    } as never);
  });

  afterAll(async () => {
    await forget();
    await dropTestCollection(db, COLL);
  });

  it('exports, plans, applies and restores a revoked default', async () => {
    expect(await state(COLL, 'read')).toEqual({ held: true, revoked: false });
    expect((await policy('DELETE', COLL, 'read')).status).toBe(200);
    const files = await pull();
    const member = JSON.parse(files['roles.json']).roles.find(
      (r: { name: string }) => r.name === 'tenant_member',
    );
    expect(member?.revokedDefaults).toEqual([{ resource: COLL, actions: ['read'] }]);
    expect(await steps(files)).toEqual([]);

    // Another instance, where the default stands: the file takes it away.
    expect((await policy('POST', COLL, 'read')).status).toBe(200);
    expect(await state(COLL, 'read')).toEqual({ held: true, revoked: false });
    expect(await steps(files)).toEqual([`- role tenant_member revoke default ${COLL} read`]);
    expect((await apply(files)).status).toBe(200);
    expect(await state(COLL, 'read')).toEqual({ held: false, revoked: true });
    expect(await pull()).toEqual(files);

    // A file that no longer lists it gives the default back.
    const roles = JSON.parse(files['roles.json']);
    for (const r of roles.roles) if (r.name === 'tenant_member') delete r.revokedDefaults;
    const restored = { ...files, 'roles.json': serialize(roles) };
    expect(await steps(restored)).toEqual([`+ role tenant_member restore default ${COLL} read`]);
    expect((await apply(restored)).status).toBe(200);
    expect(await state(COLL, 'read')).toEqual({ held: true, revoked: false });
    expect(await steps(restored)).toEqual([]);
  });

  it('revokes on a fresh instance, where the collection and the resource do not exist yet', async () => {
    expect((await policy('DELETE', COLL, 'update')).status).toBe(200);
    const files = await pull();
    const roles = JSON.parse(files['roles.json']);
    const member = roles.roles.find((r: { name: string }) => r.name === 'tenant_member');
    // Sorted by resource, as the export writes them: '-' sorts before '_'.
    member.revokedDefaults.unshift({ resource: EXT_RES, actions: ['execute'] });
    const desired = { ...files, 'roles.json': serialize(roles) };

    // Fresh: no collection, no grant, no revocation.
    await dropTestCollection(db, COLL);
    await forget();
    expect((await apply(desired)).status).toBe(200);
    expect(await state(COLL, 'update')).toEqual({ held: false, revoked: true });
    expect(await state(COLL, 'read')).toEqual({ held: true, revoked: false });
    expect(await state(EXT_RES, 'execute')).toEqual({ held: false, revoked: true });
    expect(await pull()).toEqual(desired);

    // The extension installed later does not get the revoked default back.
    await materializeDefaultGrants(db, [EXT_RES], { extension: true });
    expect(await state(EXT_RES, 'execute')).toEqual({ held: false, revoked: true });
    expect(await state(EXT_RES, 'read')).toEqual({ held: true, revoked: false });
  });
});
