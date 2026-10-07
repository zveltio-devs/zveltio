/**
 * `member` is a Casbin role; `"user".role` is only the god attribute.
 *
 * A grant `p member * <collection> read` once reached only users holding a
 * `g <user> member *` row, and only `PATCH /api/users/:id` wrote one — so 033
 * made the column a subject instead. Owner decision 2026-10-07 reverses the
 * source, not the outcome: every account creation writes the row (sign-up
 * hook), a demotion writes it, migration 059 backfilled existing accounts, and
 * the column is no longer read as a role.
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
  reconcilePolicies,
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

d('member is a Casbin role, the column only the god attribute', () => {
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
    }
    await dropTestCollection(db, MEMBER_COL);
    await dropTestCollection(db, GOD_COL);
  });

  it('a self-registered member reaches a grant written for `member`', async () => {
    const g = await sql<{ v1: string; v2: string }>`
      SELECT v1, v2 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId}
    `.execute(db);
    expect(g.rows).toEqual([{ v1: 'member', v2: '*' }]);
    expect((await read(member.cookie, MEMBER_COL)).status).toBe(200);
  });

  it('`member` expands through role inheritance', async () => {
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

  it('getUserRoles names `member`', async () => {
    expect(await getUserRoles(member.userId)).toContain('member');
  });

  it('an API key principal gains no `member`', async () => {
    expect(await checkPermission(`apikey:${crypto.randomUUID()}`, MEMBER_COL, 'read')).toBe(false);
  });

  it('PATCH leaves a global business role alone', async () => {
    await (await getEnforcer()).addRoleForUser(member.userId, 'employee', '*');
    expect((await patchRole(member.userId, 'member')).status).toBe(200);
    const rows = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId} AND v2 = '*'
      ORDER BY v1
    `.execute(db);
    // The business role kept, nothing wiped.
    expect(rows.rows.map((r) => r.v1)).toEqual(['employee', 'member']);
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

  it('POST /api/permissions/roles refuses god, and takes member like any role', async () => {
    const assign = (role: string) =>
      app.request('/api/permissions/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: admin },
        body: JSON.stringify({ userId: member.userId, role }),
      });
    expect((await assign('god')).status).toBe(422);
    expect((await assign('member')).status).toBe(200);
  });

  it('migration 059 backfills `member` for non-god accounts, re-runnably', async () => {
    const file = Bun.file(
      new URL('../../db/migrations/sql/059_member_role_in_casbin.sql', import.meta.url),
    );
    const { up } = parseMigrationFile(await file.text());
    const god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]?.id;
    // Behind the enforcer, as an upgraded table looks before 059.
    await sql`DELETE FROM zvd_permissions
              WHERE ptype = 'g' AND v0 = ${member.userId} AND v1 = 'member'`.execute(db);
    if (god) {
      await sql`DELETE FROM zvd_permissions
                WHERE ptype = 'g' AND v0 = ${god} AND v1 = 'member'`.execute(db);
    }
    await sql.raw(up).execute(db);
    await sql.raw(up).execute(db);
    const mine = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${member.userId} ORDER BY v1
    `.execute(db);
    expect(mine.rows.map((r) => r.v1)).toEqual(['employee', 'member']);
    if (god) {
      const g = await sql`SELECT 1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${god}
                          AND v1 = 'member'`.execute(db);
      expect(g.rows).toHaveLength(0);
    }
    // Bring the model to the table, as the reconcile tick would.
    await reconcilePolicies();
  });
});
