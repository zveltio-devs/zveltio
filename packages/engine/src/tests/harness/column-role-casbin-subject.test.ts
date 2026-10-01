/**
 * `"user".role` is the only source of god/member — Casbin sees it as a subject.
 *
 * A grant `p member * <collection> read` used to reach only users holding a
 * `g <user> member *` row, and only `PATCH /api/users/:id` wrote one. So a
 * self-registered member, whose role is the column default and nothing else,
 * was refused a grant written for exactly them. And the PATCH that wrote the
 * mirror did it with `deleteRolesForUser(user, '*')`, wiping every global
 * business role the user held just to copy one column into Casbin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  invalidateGodCache,
  invalidateUserPermCache,
} from '../../lib/tenancy/index.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const tag = `${Date.now()}`;
const MEMBER_COL = `hcolrole_m_${tag}`;
const GOD_COL = `hcolrole_g_${tag}`;
const INHERITED_ROLE = `hcolrole_parent_${tag}`;

d('the "user".role column is a Casbin subject', () => {
  let app: Hono;
  let db: Database;
  // An instance admin who is not god: PATCHing someone TO god needs the seat free.
  let admin = '';
  let member: { cookie: string; userId: string };

  const patchRole = (id: string, role: 'god' | 'member') =>
    app.request(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: admin },
      body: JSON.stringify({ role }),
    });
  const read = (cookie: string, col: string) =>
    app.request(`/api/data/${col}`, { headers: { cookie } });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    admin = (
      await createMemberSession(app, db, { grants: [{ collection: 'admin', actions: ['*'] }] })
    ).cookie;
    for (const name of [MEMBER_COL, GOD_COL]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
    const e = await getEnforcer();
    await e.addPolicy('member', '*', MEMBER_COL, 'read');
    await e.addPolicy('god', '*', GOD_COL, 'read');
    member = await createMemberSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    const e = await getEnforcer();
    await e.removePolicy('member', '*', MEMBER_COL, 'read');
    await e.removePolicy('god', '*', GOD_COL, 'read');
    await e.removePolicy(INHERITED_ROLE, '*', GOD_COL, 'read');
    await e.deleteRoleForUser('member', INHERITED_ROLE, '*');
    if (member?.userId) {
      await e.deleteUser(member.userId);
      await sql`DELETE FROM zvd_permissions_pruned_033 WHERE v0 = ${member.userId}`
        .execute(db)
        .catch(() => {});
    }
    await dropTestCollection(db, MEMBER_COL);
    await dropTestCollection(db, GOD_COL);
  });

  it('a self-registered member reaches a grant written for `member`', async () => {
    const g =
      await sql`SELECT 1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId}`.execute(
        db,
      );
    expect(g.rows).toHaveLength(0);
    expect((await read(member.cookie, MEMBER_COL)).status).toBe(200);
  });

  it('the column role expands through role inheritance, like a `g` row did', async () => {
    const e = await getEnforcer();
    await e.addRoleForUser('member', INHERITED_ROLE, '*');
    await e.addPolicy(INHERITED_ROLE, '*', GOD_COL, 'read');
    await invalidateUserPermCache(member.userId);
    let status = 0;
    try {
      status = (await read(member.cookie, GOD_COL)).status;
    } finally {
      // Before the next case, pass or fail: it reads GOD_COL as a plain member.
      await e.removePolicy(INHERITED_ROLE, '*', GOD_COL, 'read');
      await e.deleteRoleForUser('member', INHERITED_ROLE, '*');
      await invalidateUserPermCache(member.userId);
    }
    expect(status).toBe(200);
    expect((await read(member.cookie, GOD_COL)).status).toBe(403);
  });

  it('getUserRoles names the column role', async () => {
    expect(await getUserRoles(member.userId)).toContain('member');
  });

  it('an API key principal gains no column role', async () => {
    expect(await checkPermission(`apikey:${crypto.randomUUID()}`, MEMBER_COL, 'read')).toBe(false);
  });

  it('PATCH leaves a global business role alone', async () => {
    await (await getEnforcer()).addRoleForUser(member.userId, 'employee', '*');
    expect((await patchRole(member.userId, 'member')).status).toBe(200);
    const rows = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId} AND v2 = '*'
    `.execute(db);
    // Exactly the business role: no `member` mirror written, nothing wiped.
    expect(rows.rows.map((r) => r.v1)).toEqual(['employee']);
  });

  it('a god demoted by PATCH keeps no god-derived grant', async () => {
    // One god per instance (migration 008): stand the harness god down first.
    const gods = await sql<{ id: string }>`
      UPDATE "user" SET role = 'member' WHERE role = 'god' RETURNING id
    `.execute(db);
    for (const { id } of gods.rows) await invalidateGodCache(id);
    expect((await patchRole(member.userId, 'god')).status).toBe(200);
    expect((await read(member.cookie, GOD_COL)).status).toBe(200);
    expect((await patchRole(member.userId, 'member')).status).toBe(200);
    expect((await read(member.cookie, GOD_COL)).status).toBe(403);
    expect((await read(member.cookie, MEMBER_COL)).status).toBe(200);
  });

  it('POST /api/permissions/roles refuses god and member', async () => {
    for (const role of ['god', 'member']) {
      const res = await app.request('/api/permissions/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: admin },
        body: JSON.stringify({ userId: member.userId, role }),
      });
      expect(res.status).toBe(422);
    }
  });

  it('migration 033 deletes user→god|member mirror rows and nothing else', async () => {
    const file = Bun.file(
      new URL('../../db/migrations/sql/033_drop_column_role_mirror.sql', import.meta.url),
    );
    const { up } = parseMigrationFile(await file.text());
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES
        ('g', ${member.userId}, 'god', '*'),
        ('g', ${member.userId}, 'member', '*')
      ON CONFLICT DO NOTHING
    `.execute(db);
    await sql.raw(up).execute(db);
    const mine = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId} ORDER BY v1
    `.execute(db);
    expect(mine.rows.map((r) => r.v1)).toEqual(['employee']);
    // The seeded role→role edge is not a user's row.
    const edge = await sql`
      SELECT 1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = 'member' AND v1 = 'member' AND v2 = '*'
    `.execute(db);
    expect(edge.rows).toHaveLength(1);
    const saved = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions_pruned_033 WHERE v0 = ${member.userId} ORDER BY v1
    `.execute(db);
    expect(saved.rows.map((r) => r.v1)).toEqual(['god', 'member']);
  });
});
