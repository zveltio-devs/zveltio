/**
 * Removing a user from a tenant removes every role they hold IN that tenant.
 *
 * `DELETE /api/tenants/:id/members/:userId` revoked the four `tenant_*` grades
 * and left every other `g <user> <role> <tenant>` row — an invited `manager`, a
 * custom role. `checkPermission` kept honouring those roles' `p` rules in the
 * tenant, and a tenant flow notifying the role kept writing to the former member
 * (a grant in the tenant's own domain counts there without membership). SCIM
 * deprovisioning deletes the membership row by raw SQL and left even the grade.
 *
 * Kept: `*` grants (not tenant-scoped), grants in other tenants, and role→role
 * edges in the tenant (their v0 is a role, not this user).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import {
  checkPermission,
  clearLocalPermissionCache,
  getEnforcer,
  reconcilePolicies,
} from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TAG = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const hex = TAG.slice(-12).padStart(12, '0');
const TENANT_A = `00000000-0000-0000-00aa-${hex}`;
const TENANT_B = `00000000-0000-0000-00bb-${hex}`;
const USER = `tmr-user-${TAG}`;
const EMP = `probe_employee_${TAG}`; // the business role held in A
const MGR = `probe_manager_${TAG}`; // a role inheriting EMP in A: a role→role edge
const GLOBAL = `probe_global_${TAG}`; // held at `*`
const ROLE_B = `probe_b_${TAG}`; // held in B
const RES = `probe_res_${TAG}`;

d('removing a tenant member drops every grant they hold in that tenant', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const flowIds: string[] = [];

  const grantsOf = async (user: string) =>
    (
      await sql<{ role: string; dom: string }>`
        SELECT v1 AS role, v2 AS dom FROM zvd_permissions
         WHERE ptype = 'g' AND v0 = ${user} ORDER BY v2, v1
      `.execute(db)
    ).rows;

  const canReadInA = () => {
    clearLocalPermissionCache();
    return runWithDomain(TENANT_A, () => checkPermission(USER, RES, 'read'));
  };

  async function notifiedInA(role: string): Promise<string[]> {
    const title = `tmr-${flowIds.length}-${TAG}`;
    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
      VALUES (${TENANT_A}, ${title}, 'manual', '{}'::jsonb, true)
      RETURNING id::text AS id
    `.execute(db);
    const flowId = flow.rows[0]!.id;
    flowIds.push(flowId);
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'notify', 'send_notification',
              ${JSON.stringify({ role, title, message: 'm' })}::jsonb, 'stop')
    `.execute(db);
    expect((await executeFlow(db, flowId)).status).toBe('success');
    const rows = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_notifications WHERE title = ${title}
    `.execute(db);
    return rows.rows.map((r) => r.user_id);
  }

  async function enrolInA(): Promise<void> {
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT_A}::uuid, ${USER}, 'member')
              ON CONFLICT DO NOTHING`.execute(db);
    // As POST /:id/members and invitation accept grant: through the enforcer.
    const e = await getEnforcer();
    await e.addRoleForUser(USER, 'tenant_member', TENANT_A);
    await e.addRoleForUser(USER, EMP, TENANT_A);
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${USER}, ${USER}, ${`${USER}@test.local`}, false, 'member', NOW(), NOW())
    `.execute(db);
    for (const [id, slug] of [
      [TENANT_A, `tmr-a-${TAG}`],
      [TENANT_B, `tmr-b-${TAG}`],
    ] as const) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${id}::uuid, ${slug}, ${slug}, 'active')`.execute(db);
    }
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT_B}::uuid, ${USER}, 'member')`.execute(db);
    const e = await getEnforcer();
    await e.addRoleForUser(USER, GLOBAL, '*');
    await e.addRoleForUser(USER, ROLE_B, TENANT_B);
    await e.addRoleForUser(MGR, EMP, TENANT_A);
    await e.addPolicy(EMP, TENANT_A, RES, 'read');
    await enrolInA();
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of flowIds) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_notifications WHERE user_id = ${USER}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`%${TAG}%`} OR v1 LIKE ${`%${TAG}%`}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_permissions_pruned_034 WHERE v0 = ${USER}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${USER}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`
      .execute(db)
      .catch(() => {});
    await reconcilePolicies();
    clearLocalPermissionCache();
  });

  it('DELETE /api/tenants/:id/members/:userId revokes every role in A, live, and keeps the rest', async () => {
    expect(await canReadInA()).toBe(true);
    expect(await notifiedInA(EMP)).toEqual([USER]);

    const res = await app.request(`/api/tenants/${TENANT_A}/members/${USER}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    expect(await grantsOf(USER)).toEqual([
      { role: GLOBAL, dom: '*' },
      { role: ROLE_B, dom: TENANT_B },
    ]);
    expect(await grantsOf(MGR)).toEqual([{ role: EMP, dom: TENANT_A }]);
    // The live enforcer, without a reconcile: the route removed it there too.
    expect(await canReadInA()).toBe(false);
    expect(await notifiedInA(EMP)).toEqual([]);
  });

  it('a membership row deleted by raw SQL (the SCIM path) takes the grants with it', async () => {
    // This instance has caught up with the table; the grant and the raw delete
    // then land between two reconcile ticks, leaving the table as it was at
    // the first. The tick must still see the live model holds more than it.
    await reconcilePolicies();
    await enrolInA();
    expect(await canReadInA()).toBe(true);

    await db.transaction().execute(async (trx) => {
      await sql`DELETE FROM zv_tenant_users
                 WHERE tenant_id = ${TENANT_A}::uuid AND user_id = ${USER}`.execute(trx);
    });

    expect((await grantsOf(USER)).map((g) => g.dom)).toEqual(['*', TENANT_B]);
    expect(await notifiedInA(EMP)).toEqual([]);
    await reconcilePolicies();
    expect(await canReadInA()).toBe(false);
  });

  it('removing a membership and re-adding it in one transaction keeps its grants', async () => {
    await enrolInA();
    await db.transaction().execute(async (trx) => {
      await sql`DELETE FROM zv_tenant_users
                 WHERE tenant_id = ${TENANT_A}::uuid AND user_id = ${USER}`.execute(trx);
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
                VALUES (${TENANT_A}::uuid, ${USER}, 'member')`.execute(trx);
    });
    expect((await grantsOf(USER)).filter((g) => g.dom === TENANT_A).map((g) => g.role)).toEqual(
      [EMP, 'tenant_member'].sort(),
    );
  });

  it('the enforcer revoking on the pool while the membership delete is uncommitted does not wait on it', async () => {
    // SCIM's shape: membership deleted in a transaction, then `internals.deleteUser`
    // removes the grants through the enforcer, whose adapter writes on the pool.
    await reconcilePolicies();
    await enrolInA();
    await db.transaction().execute(async (trx) => {
      await sql`DELETE FROM zv_tenant_users
                 WHERE tenant_id = ${TENANT_A}::uuid AND user_id = ${USER}`.execute(trx);
      await (await getEnforcer()).deleteRolesForUser(USER, TENANT_A);
    });
    expect((await grantsOf(USER)).map((g) => g.dom)).toEqual(['*', TENANT_B]);
  }, 15_000);

  it('migration 034 prunes grants in tenants the user left, and keeps default, `*`, member and role→role rows', async () => {
    // State here: USER is a member of B only. Rows written straight to the table,
    // as the old route left them: the trigger fires on membership deletes, not here.
    const DEF = '00000000-0000-0000-0000-000000000001';
    const DEF_ROLE = `probe_default_${TAG}`;
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES
        ('g', ${USER}, ${EMP}, ${TENANT_A}),
        ('g', ${USER}, 'tenant_member', ${TENANT_A}),
        ('g', ${USER}, ${DEF_ROLE}, ${DEF})
    `.execute(db);
    const file = Bun.file(
      new URL('../../db/migrations/sql/034_drop_removed_member_tenant_grants.sql', import.meta.url),
    );
    await sql.raw(parseMigrationFile(await file.text()).up).execute(db);

    expect((await grantsOf(USER)).map((g) => `${g.dom} ${g.role}`).sort()).toEqual(
      [`${DEF} ${DEF_ROLE}`, `* ${GLOBAL}`, `${TENANT_B} ${ROLE_B}`].sort(),
    );
    const edge = await sql`
      SELECT 1 FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${MGR} AND v1 = ${EMP} AND v2 = ${TENANT_A}
    `.execute(db);
    expect(edge.rows).toHaveLength(1);
    const saved = await sql<{ v1: string }>`
      SELECT v1 FROM zvd_permissions_pruned_034 WHERE v0 = ${USER} ORDER BY v1
    `.execute(db);
    expect(saved.rows.map((r) => r.v1)).toEqual([EMP, 'tenant_member'].sort());
  });
});
