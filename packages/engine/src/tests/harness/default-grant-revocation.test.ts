/**
 * An operator's revoke of a default grant survives boot and extension load.
 *
 * `materializeDefaultGrants` writes the default grants with ON CONFLICT DO
 * NOTHING at every boot, extension load and collection create. Nothing recorded
 * a deletion, so a default an operator removed came back on the next boot.
 * Migration 086 records it (`zv_default_grant_revocations`), written by the
 * Casbin adapter in the statement that deletes the rule; the materializer skips
 * what it records, and granting the triple again clears it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  getEnforcer,
  listKnownResources,
  materializeDefaultGrants,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COLL = `dgr_${tag}`;
const DROPPED = `dgr_drop_${tag}`;
const EXT_RES = `dgr-ext-${tag}`;
const LATER_RES = `dgr-later-${tag}`;
const ROLE = `dgr_role_${tag}`;

d('a revoked default grant stays revoked', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let tenantMemberRoleId: string | undefined;

  const policy = (method: 'POST' | 'DELETE', subject: string, resource: string, action: string) =>
    app.request('/api/permissions/policies', {
      method,
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ subject, resource, action }),
    });

  const held = async (role: string, resource: string, action: string) => {
    const { rows } = await sql`
      SELECT 1 FROM zvd_permissions
       WHERE ptype = 'p' AND v0 = ${role} AND v1 = '*' AND v2 = ${resource} AND v3 = ${action}
    `.execute(db);
    return rows.length > 0;
  };
  const revoked = async (role: string, resource: string, action: string) => {
    const { rows } = await sql`
      SELECT 1 FROM zv_default_grant_revocations
       WHERE role = ${role} AND resource = ${resource} AND action = ${action}
    `.execute(db);
    return rows.length > 0;
  };
  const inModel = async (role: string, resource: string, action: string) =>
    (await getEnforcer()).getModel().hasPolicy('p', 'p', [role, '*', resource, action]);

  /** The boot reconcile's collection half, then the extension-load call. */
  const bootAndLoad = async () => {
    await materializeDefaultGrants(db, await listKnownResources(db));
    await materializeDefaultGrants(db, [COLL, EXT_RES], { extension: true });
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    await materializeDefaultGrants(db, [EXT_RES], { extension: true });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE} OR v2 IN (${COLL}, ${DROPPED}, ${EXT_RES}, ${LATER_RES})`.execute(
      db,
    );
    await sql`DELETE FROM zv_default_grant_revocations WHERE resource IN (${COLL}, ${DROPPED}, ${EXT_RES}, ${LATER_RES})`.execute(
      db,
    );
    if (tenantMemberRoleId) {
      await sql`DELETE FROM zv_roles WHERE id = ${tenantMemberRoleId}`.execute(db);
    }
    await sql`DELETE FROM zv_roles WHERE name = ${ROLE}`.execute(db);
    await dropTestCollection(db, COLL);
    await dropTestCollection(db, DROPPED);
  });

  it('DELETE /api/permissions/policies on a default survives boot and extension load', async () => {
    expect(await held('tenant_viewer', COLL, 'read')).toBe(true);
    expect((await policy('DELETE', 'tenant_viewer', COLL, 'read')).status).toBe(200);
    expect(await held('tenant_viewer', COLL, 'read')).toBe(false);
    expect(await revoked('tenant_viewer', COLL, 'read')).toBe(true);

    await bootAndLoad();
    expect(await held('tenant_viewer', COLL, 'read')).toBe(false);
    expect(await inModel('tenant_viewer', COLL, 'read')).toBe(false);
    // The rest of the collection's defaults were not touched.
    expect(await held('tenant_member', COLL, 'read')).toBe(true);
  });

  it('an extension resource default (execute) stays revoked through extension load', async () => {
    expect(await held('tenant_member', EXT_RES, 'execute')).toBe(true);
    expect((await policy('DELETE', 'tenant_member', EXT_RES, 'execute')).status).toBe(200);
    expect(await revoked('tenant_member', EXT_RES, 'execute')).toBe(true);
    await bootAndLoad();
    expect(await held('tenant_member', EXT_RES, 'execute')).toBe(false);
  });

  it('revoking a default whose resource is not here yet keeps it revoked once it arrives', async () => {
    // An extension installed later: the delete removes no rule, as a schema apply's
    // would not, and the revocation is recorded all the same.
    expect(await held('tenant_member', LATER_RES, 'execute')).toBe(false);
    expect((await policy('DELETE', 'tenant_member', LATER_RES, 'execute')).status).toBe(200);
    expect(await revoked('tenant_member', LATER_RES, 'execute')).toBe(true);
    await materializeDefaultGrants(db, [LATER_RES], { extension: true });
    expect(await held('tenant_member', LATER_RES, 'execute')).toBe(false);
    expect(await inModel('tenant_member', LATER_RES, 'execute')).toBe(false);
  });

  it('granting the triple again explicitly clears the revocation, and the grant stays', async () => {
    expect((await policy('POST', 'tenant_viewer', COLL, 'read')).status).toBe(200);
    expect(await revoked('tenant_viewer', COLL, 'read')).toBe(false);
    expect(await held('tenant_viewer', COLL, 'read')).toBe(true);
    await bootAndLoad();
    expect(await held('tenant_viewer', COLL, 'read')).toBe(true);
    expect(await inModel('tenant_viewer', COLL, 'read')).toBe(true);
  });

  it('deleting a policy that is not a default records nothing', async () => {
    expect((await policy('POST', ROLE, COLL, 'read')).status).toBe(200);
    expect((await policy('DELETE', ROLE, COLL, 'read')).status).toBe(200);
    // A default role, an action it is not given by default.
    expect((await policy('POST', 'tenant_member', COLL, 'delete')).status).toBe(200);
    expect((await policy('DELETE', 'tenant_member', COLL, 'delete')).status).toBe(200);
    const { rows } = await sql`
      SELECT role, action FROM zv_default_grant_revocations WHERE resource = ${COLL}`.execute(db);
    expect(rows).toEqual([]);
  });

  it('a schema apply neither restores a revoked default nor plans one', async () => {
    expect((await policy('DELETE', 'tenant_viewer', COLL, 'read')).status).toBe(200);
    const exported = await app.request('/api/admin/schema/export', { headers: { cookie: god } });
    const { files } = (await exported.json()) as { files: Record<string, string> };
    const res = await app.request('/api/admin/schema/apply', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    });
    expect(res.status).toBe(200);
    const { steps } = (await res.json()) as { steps: { target: string }[] };
    expect(steps.filter((s) => s.target.includes(COLL))).toEqual([]);
    expect(await revoked('tenant_viewer', COLL, 'read')).toBe(true);
    await bootAndLoad();
    expect(await held('tenant_viewer', COLL, 'read')).toBe(false);
    expect((await policy('POST', 'tenant_viewer', COLL, 'read')).status).toBe(200);
  });

  it('a dropped collection takes its revocations: one created again gets its defaults', async () => {
    await DDLManager.createCollection(db, {
      name: DROPPED,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    expect((await policy('DELETE', 'tenant_member', DROPPED, 'update')).status).toBe(200);
    expect(await revoked('tenant_member', DROPPED, 'update')).toBe(true);

    await DDLManager.dropCollection(db, DROPPED);
    expect(await revoked('tenant_member', DROPPED, 'update')).toBe(false);

    await DDLManager.createCollection(db, {
      name: DROPPED,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    expect(await held('tenant_member', DROPPED, 'update')).toBe(true);
  });

  it('the matrix bulk save: omitting a default revokes it, including it records nothing', async () => {
    // The matrix lists roles with a zv_roles row; a tenant role gets one by POST /roles.
    const created = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'tenant_member' }),
    });
    expect(created.status).toBe(201);
    tenantMemberRoleId = ((await created.json()) as { role: { id: string } }).role.id;

    const current = await app.request('/api/admin/permissions', { headers: { cookie: god } });
    const { permissions, version } = (await current.json()) as {
      permissions: { role_id: string; resource: string; action: string }[];
      version: string;
    };
    const omitted = (p: { role_id: string; resource: string; action: string }) =>
      p.role_id === tenantMemberRoleId && p.resource === COLL && p.action === 'create';
    expect(permissions.some(omitted)).toBe(true);
    const bulk = (list: typeof permissions, at: string) =>
      app.request('/api/admin/permissions/bulk', {
        method: 'POST',
        headers: { cookie: god, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: list, version: at }),
      });

    // A rule the save keeps is not deleted and re-inserted: a save that died
    // half-way through a delete-everything pass would revoke every default.
    const rowOf = async () =>
      (
        await sql`SELECT id FROM zvd_permissions
                   WHERE ptype = 'p' AND v0 = 'tenant_member' AND v1 = '*'
                     AND v2 = ${COLL} AND v3 = 'read'`.execute(db)
      ).rows[0];
    const before = await rowOf();
    expect(
      (
        await bulk(
          permissions.filter((p) => !omitted(p)),
          version,
        )
      ).status,
    ).toBe(200);
    expect(await rowOf()).toEqual(before);
    expect(await held('tenant_member', COLL, 'create')).toBe(false);
    expect(await revoked('tenant_member', COLL, 'create')).toBe(true);
    expect(await revoked('tenant_member', COLL, 'read')).toBe(false);
    await bootAndLoad();
    expect(await held('tenant_member', COLL, 'create')).toBe(false);

    const reloaded = (await (
      await app.request('/api/admin/permissions', { headers: { cookie: god } })
    ).json()) as { version: string };
    expect((await bulk(permissions, reloaded.version)).status).toBe(200);
    expect(await held('tenant_member', COLL, 'create')).toBe(true);
    // This collection only: on a shared database other suites' cleanups delete
    // default rules on their own collections, and those are revocations too.
    const { rows } = await sql`
      SELECT 1 FROM zv_default_grant_revocations
       WHERE role = 'tenant_member' AND resource = ${COLL}`.execute(db);
    expect(rows).toEqual([]);
  });

  it('the matrix leaves a tenant-domain rule alone: not listed, not dropped, not made global', async () => {
    expect(tenantMemberRoleId).toBeDefined();
    const tenantDomain = crypto.randomUUID();
    const e = await getEnforcer();
    await e.addPolicy('tenant_member', tenantDomain, COLL, 'delete');
    try {
      const current = await app.request('/api/admin/permissions', { headers: { cookie: god } });
      const { permissions, version } = (await current.json()) as {
        permissions: { role_id: string; resource: string; action: string }[];
        version: string;
      };
      expect(
        permissions.some(
          (p) => p.role_id === tenantMemberRoleId && p.resource === COLL && p.action === 'delete',
        ),
      ).toBe(false);
      const saved = await app.request('/api/admin/permissions/bulk', {
        method: 'POST',
        headers: { cookie: god, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions, version }),
      });
      expect(saved.status).toBe(200);
      const { rows } = await sql<{ v1: string }>`
        SELECT v1 FROM zvd_permissions
         WHERE ptype = 'p' AND v0 = 'tenant_member' AND v2 = ${COLL} AND v3 = 'delete'`.execute(db);
      expect(rows.map((r) => r.v1)).toEqual([tenantDomain]);
    } finally {
      await e.removePolicy('tenant_member', tenantDomain, COLL, 'delete');
    }
  });
});
