/**
 * A flow's `send_notification` to `member` reaches the holders of the Casbin
 * `g <user> member *` row — in the flow's tenant only — and `god` reaches
 * nobody: it is an instance attribute in `"user".role`, not a role (owner
 * decision 2026-10-07, Casbin is the one source of roles).
 *
 * Between #785 and 059 the column was the source of `member`, and a lookup that
 * read `g` rows alone reached nobody. Now every account is created with the row
 * (migration 059 backfilled the rest), which these raw inserts reproduce.
 *
 * A `*` row holds in every domain, so "everyone holding member" would carry
 * tenant A's message to tenant B's members. It counts in a tenant only for its
 * members (`zv_tenant_users`) — everybody, in the default tenant, as with the
 * membership middleware. There is exactly one god per instance
 * (`zveltio_one_god_only`): the test borrows the existing one, or creates it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-00000000f20a';
const TENANT_B = '00000000-0000-0000-0000-00000000f20b';
const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const EMPLOYEE = `probe_employee_${TAG}`;

d('flow send_notification to `member`, per tenant', () => {
  let db: Database;
  let god = '';
  let ownGod = false;
  const flowIds: string[] = [];
  const u = {
    memberA: `fcr-ma-${TAG}`,
    memberB: `fcr-mb-${TAG}`,
    employeeA: `fcr-ea-${TAG}`,
  };

  async function notifiedBy(tenantId: string, role: string): Promise<string[]> {
    const title = `fcr-${role}-${tenantId.slice(-4)}-${flowIds.length}-${TAG}`;
    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
      VALUES (${tenantId}, ${title}, 'manual', '{}'::jsonb, true)
      RETURNING id::text AS id
    `.execute(db);
    const flowId = flow.rows[0]!.id;
    flowIds.push(flowId);
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'notify', 'send_notification',
              ${JSON.stringify({ role, title, message: 'tenant secret' })}::jsonb, 'stop')
    `.execute(db);
    const res = await executeFlow(db, flowId);
    expect(res.status).toBe('success');
    const rows = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_notifications WHERE title = ${title}
    `.execute(db);
    return rows.rows.map((r) => r.user_id);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const [tid, slug] of [
      [TENANT_A, `fcr-a-${TAG}`],
      [TENANT_B, `fcr-b-${TAG}`],
    ]) {
      await sql`INSERT INTO zv_tenants (id, slug, name, status)
                VALUES (${tid}::uuid, ${slug}, ${slug}, 'active')
                ON CONFLICT DO NOTHING`.execute(db);
    }
    const existing = await sql<{ id: string }>`
      SELECT id FROM "user" WHERE role = 'god' LIMIT 1
    `.execute(db);
    god = existing.rows[0]?.id ?? `fcr-god-${TAG}`;
    if (!existing.rows[0]) {
      ownGod = true;
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${god}, ${god}, ${`${god}@test.local`}, false, 'god', NOW(), NOW())
      `.execute(db);
    }
    const users: Array<[string, 'member', string]> = [
      [u.memberA, 'member', TENANT_A],
      [u.memberB, 'member', TENANT_B],
      [u.employeeA, 'member', TENANT_A],
    ];
    for (const [id, role, tenant] of users) {
      // 059's trigger gives the account its `member` row in Casbin.
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@test.local`}, false, ${role}, NOW(), NOW())
      `.execute(db);
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
                VALUES (${tenant}::uuid, ${id}, 'member')`.execute(db);
    }
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${u.employeeA}, ${EMPLOYEE}, ${TENANT_A})
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of flowIds) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zvd_permissions WHERE v1 = ${EMPLOYEE}`.execute(db).catch(() => {});
    for (const id of Object.values(u)) {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${id}`.execute(db).catch(() => {});
    }
    for (const id of [...Object.values(u), ...(ownGod ? [god] : [])]) {
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`
      .execute(db)
      .catch(() => {});
  });

  it('a tenant-A `member` step reaches tenant A members, not tenant B members', async () => {
    const to = await notifiedBy(TENANT_A, 'member');
    expect(to).toContain(u.memberA);
    expect(to).toContain(u.employeeA);
    expect(to).not.toContain(u.memberB);
    expect(to).not.toContain(god);
  });

  it('a `god` step reaches nobody: god is not a role, enrolled or not', async () => {
    expect(await notifiedBy(TENANT_A, 'god')).toEqual([]);
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT_A}::uuid, ${god}, 'admin')`.execute(db);
    expect(await notifiedBy(TENANT_A, 'god')).toEqual([]);
  });

  it('a business role granted in tenant A still resolves', async () => {
    expect(await notifiedBy(TENANT_A, EMPLOYEE)).toEqual([u.employeeA]);
  });

  it('in the default tenant every account counts, enrolled or not', async () => {
    const members = await notifiedBy(DEFAULT_TENANT_ID, 'member');
    for (const id of [u.memberA, u.memberB, u.employeeA]) expect(members).toContain(id);
    expect(await notifiedBy(DEFAULT_TENANT_ID, 'god')).toEqual([]);
  });
});
