/**
 * The column exemption is a permission held by an identity, not a role name.
 *
 * `getColumnAccess` used to short-circuit on `role === 'admin' || role ===
 * 'superadmin'`, before reading any configured rule. Measured against every
 * value the CHECK constraint on `"user".role` permits (`001_initial.sql:1160`:
 * god, admin, manager, member) that produced an inversion — `admin` exempt,
 * `god` masked, and `superadmin` not assignable at all, so half the condition
 * could never fire.
 *
 * Restoring the intent as `role === 'god'` would have repeated the mistake in a
 * tidier spelling. `lib/tenancy/rls.ts` met the same shape and says why a name
 * is the wrong mechanism: "a string comparison against a role name is
 * invisible, unauditable and impossible to revoke."
 *
 * So the exemption is `data:view_all_columns`, resolved through
 * `checkPermission`, which returns true for a god user before consulting any
 * policy. That is where "god can do anything" lives, once, for the whole
 * engine — god passes THROUGH the permission system rather than around it.
 * Everything else is deny-by-default, so god is the only exempt identity until
 * an operator grants the permission to someone, deliberately, in a row they can
 * see and revoke.
 *
 * Four cases, and the last two are the ones that make this a permission rather
 * than a longer list of privileged names.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getColumnAccess } from '../../lib/tenancy/column-permissions.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLL = `colperm_${STAMP}`;
const SECRET = 'salary';

const MEMBER = `colperm-member-${STAMP}`;
const GRANTED = `colperm-granted-${STAMP}`;

d('column access is exempted by permission, not by role name', () => {
  let app: Hono;
  let db: Database;
  let god = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());

    // The database permits exactly one god (migration 008), so this asks the
    // harness for one rather than inserting a second — which is refused with
    // "this instance already has a god".
    await createGodSession(app, db);
    god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god' LIMIT 1`.execute(db))
      .rows[0]!.id;

    await sql`
      INSERT INTO zvd_column_permissions (collection_name, column_name, role, can_read, can_write)
      VALUES (${COLL}, ${SECRET}, '*', false, false)
      ON CONFLICT (collection_name, column_name, role) DO UPDATE SET can_read = false
    `.execute(db);

    for (const [id, role] of [
      [MEMBER, 'member'],
      [GRANTED, 'member'],
    ]) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@probe.invalid`}, false, ${role}, now(), now())
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role
      `.execute(db);
    }

    // One ordinary member is granted the exemption explicitly. This is the
    // case a role-name check cannot express at all.
    const enforcer = await getEnforcer();
    await enforcer.addPolicy(GRANTED, '*', 'data', 'view_all_columns');
    for (const id of [god, MEMBER, GRANTED]) await invalidateUserPermCache(id);
  });

  afterAll(async () => {
    const enforcer = await getEnforcer();
    await enforcer.removePolicy(GRANTED, '*', 'data', 'view_all_columns').catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLL}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id IN (${MEMBER}, ${GRANTED})`.execute(db).catch(() => {});
  });

  it('exempts god, who holds every permission', async () => {
    const access = await getColumnAccess(db, COLL, 'god', god);
    expect(access.hidden.has(SECRET)).toBe(false);
  });

  it('masks an ordinary member', async () => {
    const access = await getColumnAccess(db, COLL, 'member', MEMBER);
    expect(access.hidden.has(SECRET)).toBe(true);
  });

  it('exempts a member the operator granted data:view_all_columns', async () => {
    // The point of the mechanism: the exemption is grantable to a named
    // identity without editing code, and visible in the policy table.
    const access = await getColumnAccess(db, COLL, 'member', GRANTED);
    expect(access.hidden.has(SECRET)).toBe(false);
  });

  it('masks that same member again once the grant is revoked', async () => {
    // And revocable, which a hardcoded role name is not. Revoking through the
    // enforcer is what the admin routes do; #451's sibling defect meant a
    // revoke like this deleted no row and came back after a restart, so this
    // asserts the row is really gone rather than only the memo.
    const enforcer = await getEnforcer();
    await enforcer.removePolicy(GRANTED, '*', 'data', 'view_all_columns');
    await invalidateUserPermCache(GRANTED);

    const still = await sql<{ c: string }>`
      SELECT count(*) AS c FROM zvd_permissions
       WHERE ptype = 'p' AND v0 = ${GRANTED} AND v2 = 'data' AND v3 = 'view_all_columns'
    `.execute(db);
    expect(still.rows[0]?.c).toBe('0');

    const access = await getColumnAccess(db, COLL, 'member', GRANTED);
    expect(access.hidden.has(SECRET)).toBe(true);
  });
});
