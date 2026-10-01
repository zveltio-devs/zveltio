/**
 * A flow's `send_notification` to a role reaches that role in the flow's tenant.
 *
 * The role lookup read `zvd_permissions` by role name alone. That table is global
 * — a grant is `(user, role, domain)` with the tenant id as domain — so a tenant-A
 * flow notifying `role: 'x'` wrote its title and message to every holder of `x`
 * in every tenant on the instance.
 *
 * A grant in the flow's own tenant domain counts as it is. A grant at domain `*`
 * holds in every domain, so it counts only for a member of the flow's tenant
 * (`zv_tenant_users`; everybody, in the default tenant). This file used to
 * assert that an unenrolled `*` holder WAS reached: that was the same leak one
 * row up — `POST /api/permissions/roles` writes every role at `*`, so a tenant-A
 * flow told tenant B's holders.
 *
 * Roles inherit as the enforcer walks them: `g manager employee *` makes a
 * holder of `manager` a holder of `employee`. A cycle terminates. A user holding
 * the role several ways is told once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-00000000f10a';
const TENANT_B = '00000000-0000-0000-0000-00000000f10b';
const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ROLE = `probe_notify_${TAG}`;
const MANAGER = `probe_mgr_${TAG}`;
const CYC_X = `probe_cx_${TAG}`;
const CYC_Y = `probe_cy_${TAG}`;
const ROLES = [ROLE, MANAGER, CYC_X, CYC_Y];

d('flow send_notification to a role stays in the flow tenant', () => {
  let db: Database;
  const flowIds: string[] = [];
  const users = {
    inA: `fnr-a-${TAG}`,
    inB: `fnr-b-${TAG}`,
    everywhere: `fnr-star-${TAG}`,
    manager: `fnr-mgr-${TAG}`,
    cyclic: `fnr-cyc-${TAG}`,
  };

  async function notifiedBy(tenantId: string, role: string): Promise<string[]> {
    const title = `fnr-${flowIds.length}-${TAG}`;
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
              ${JSON.stringify({ role, title, message: 'secret of the tenant' })}::jsonb,
              'stop')
    `.execute(db);
    const res = await executeFlow(db, flowId);
    expect(res.status).toBe('success');
    const rows = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_notifications WHERE title = ${title} ORDER BY user_id
    `.execute(db);
    const to = rows.rows.map((r) => r.user_id);
    expect(res.output.count).toBe(to.length);
    return to;
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const id of Object.values(users)) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
      `.execute(db);
    }
    const grants: Array<[string, string, string]> = [
      [users.inA, ROLE, TENANT_A],
      [users.inA, ROLE, '*'],
      [users.inB, ROLE, TENANT_B],
      [users.everywhere, ROLE, '*'],
      // manager inherits ROLE; the user holds only manager, in tenant A.
      [users.manager, MANAGER, TENANT_A],
      [MANAGER, ROLE, '*'],
      // X and Y inherit each other.
      [CYC_X, CYC_Y, '*'],
      [CYC_Y, CYC_X, '*'],
      [users.cyclic, CYC_X, TENANT_A],
    ];
    for (const [v0, v1, dom] of grants) {
      await sql`
        INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${v0}, ${v1}, ${dom})
      `.execute(db);
    }
    // The flow's firm must exist: the executor refuses to run a flow whose firm
    // it cannot see rather than run it as the default one.
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${TENANT_A}::uuid, ${`fnr-${TAG}`}, 'fnr', 'active')
              ON CONFLICT DO NOTHING`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of flowIds) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
    }
    for (const r of ROLES) {
      await sql`DELETE FROM zvd_permissions WHERE v0 = ${r} OR v1 = ${r}`
        .execute(db)
        .catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${TENANT_A}::uuid`.execute(db).catch(() => {});
    for (const id of Object.values(users)) {
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
    }
  });

  it('reaches tenant-A grants and inherited holders, once each; not tenant B, not an unenrolled `*` holder', async () => {
    expect(await notifiedBy(TENANT_A, ROLE)).toEqual([users.inA, users.manager].sort());
  });

  it('reaches a `*` holder once they are enrolled in the tenant', async () => {
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${TENANT_A}::uuid, ${users.everywhere}, 'member')`.execute(db);
    expect(await notifiedBy(TENANT_A, ROLE)).toEqual(
      [users.inA, users.manager, users.everywhere].sort(),
    );
  });

  it('in the default tenant, `*` holders count; tenant-A-only grants do not', async () => {
    expect(await notifiedBy(DEFAULT_TENANT_ID, ROLE)).toEqual([users.inA, users.everywhere].sort());
  });

  it('a role cycle terminates and still resolves its holders', async () => {
    expect(await notifiedBy(TENANT_A, CYC_Y)).toEqual([users.cyclic]);
  });
});
