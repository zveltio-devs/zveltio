/**
 * A flow's `send_notification` to a role reaches that role in the flow's tenant.
 *
 * The role lookup read `zvd_permissions` by role name alone. That table is global
 * — a grant is `(user, role, domain)` with the tenant id as domain — so a tenant-A
 * flow notifying `role: 'x'` wrote its title and message to every holder of `x`
 * in every tenant on the instance.
 *
 * A grant at domain `*` counts, because the enforcer's `g` treats it as every
 * domain; and a user holding the role both ways is told once, not twice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-00000000f10a';
const TENANT_B = '00000000-0000-0000-0000-00000000f10b';
const TAG = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ROLE = `probe_notify_${TAG}`;
const TITLE = `probe-title-${TAG}`;

d('flow send_notification to a role stays in the flow tenant', () => {
  let db: Database;
  let flowId = '';
  const users: Record<'inA' | 'inB' | 'everywhere', string> = {
    inA: `fnr-a-${TAG}`,
    inB: `fnr-b-${TAG}`,
    everywhere: `fnr-star-${TAG}`,
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    for (const id of Object.values(users)) {
      await sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
        VALUES (${id}, ${id}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
      `.execute(db);
    }
    const grants: Array<[string, string]> = [
      [users.inA, TENANT_A],
      [users.inA, '*'],
      [users.inB, TENANT_B],
      [users.everywhere, '*'],
    ];
    for (const [uid, dom] of grants) {
      await sql`
        INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${uid}, ${ROLE}, ${dom})
      `.execute(db);
    }
    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
      VALUES (${TENANT_A}, ${`probe-notify-${TAG}`}, 'manual', '{}'::jsonb, true)
      RETURNING id::text AS id
    `.execute(db);
    flowId = flow.rows[0]!.id;
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${flowId}, 0, 'notify', 'send_notification',
              ${JSON.stringify({ role: ROLE, title: TITLE, message: 'secret of tenant A' })}::jsonb,
              'stop')
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${flowId}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${flowId}`.execute(db).catch(() => {});
    await sql`DELETE FROM zv_flows WHERE id = ${flowId}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_permissions WHERE v1 = ${ROLE}`.execute(db).catch(() => {});
    for (const id of Object.values(users)) {
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db).catch(() => {});
    }
  });

  it('notifies the role holders of the flow tenant only, once each', async () => {
    const res = await executeFlow(db, flowId);
    expect(res.status).toBe('success');

    const rows = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_notifications WHERE title = ${TITLE} ORDER BY user_id
    `.execute(db);
    expect(rows.rows.map((r) => r.user_id)).toEqual([users.inA, users.everywhere].sort());
    expect(res.output.count).toBe(2);
  });
});
