/**
 * Phase C — flow EXECUTOR tenant isolation (PR2, the background/executor pass).
 *
 * Regression: flow-executor derived the tenant for data-access steps (query_db /
 * export_collection, which run inside a `set_config('zveltio.current_tenant', …)`
 * transaction against FORCE-RLS'd collection tables) from CALLER-supplied
 * `triggerData.tenantId`, falling back to the default tenant. So a tenant-B flow ran
 * its query_db/export steps as the DEFAULT tenant (cross-tenant read/export), and a
 * caller could pass `tenantId` to run a flow's data steps as ANY tenant (escalation).
 * Fix: executeFlow resolves the flow's OWN tenant_id and threads it, ignoring the
 * caller. A write's change event only enqueues flows of the writing tenant.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { enqueueChangeEvent } from '../../lib/webhooks.js';
import {
  asEveryTenant,
  asTenant,
  drainFlowJobs,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';
import { DDLManager } from '../../lib/data/index.js';

const d = harnessAvailable() ? describe : describe.skip;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';
const STAMP = Date.now();
const PROBE_COLLECTION = `zzz_flow_probe_${STAMP}`;

// A query_db step that echoes the tenant GUC the executor set for this run.
const ECHO_TENANT = { query: "SELECT current_setting('zveltio.current_tenant', true) AS tenant" };

async function makeFlow(
  db: Database,
  tenant: string,
  triggerType: 'manual' | 'on_create',
  triggerConfig: Record<string, unknown> = {},
): Promise<string> {
  const row = await asTenant(db, tenant, (trx) =>
    sql<{ id: string }>`
    INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active)
    VALUES (${tenant}, ${`probe-${tenant}-${STAMP}`}, ${triggerType},
            ${JSON.stringify(triggerConfig)}::jsonb, true)
    RETURNING id::text AS id
  `.execute(trx),
  );
  const flowId = row.rows[0]!.id;
  await sql`
    INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
    VALUES (${flowId}, 0, 'echo', 'query_db', ${JSON.stringify(ECHO_TENANT)}::jsonb, 'stop')
  `.execute(db);
  return flowId;
}

const echoedTenant = (out: unknown): string | undefined =>
  Array.isArray(out) ? (out[0] as { tenant?: string })?.tenant : undefined;

d('flow executor tenant isolation (in-process)', () => {
  let db: Database;
  const created: string[] = [];

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // A real collection: a webhook or a data trigger reads its record as its
    // role (ADR 0004), and a role reads collections only.
    await DDLManager.createCollection(db, {
      name: PROBE_COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // A real firm: `zv_flows` is under the tenant policy (migration 027), and the
    // executor finds a flow's firm through a reach made of the firms that exist.
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER_TENANT}::uuid, ${`exec-iso-${STAMP}`}, 'exec-iso', 'active')
              ON CONFLICT (id) DO NOTHING`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, PROBE_COLLECTION).catch(() => {});
    for (const id of created) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await asEveryTenant(db, (trx) => sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(trx));
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}::uuid`.execute(db).catch(() => {});
  });

  it('runs a flow with ITS OWN tenant, not the default tenant', async () => {
    const flowId = await makeFlow(db, OTHER_TENANT, 'manual');
    created.push(flowId);
    const res = await executeFlow(db, flowId);
    expect(res.status).toBe('success');
    expect(echoedTenant(res.output)).toBe(OTHER_TENANT);
  });

  it('ignores a caller-supplied tenantId (no cross-tenant spoof)', async () => {
    const flowId = await makeFlow(db, OTHER_TENANT, 'manual');
    created.push(flowId);
    // Caller tries to make the flow's data steps run as the default tenant.
    const res = await executeFlow(db, flowId, { tenantId: DEFAULT_TENANT });
    expect(res.status).toBe('success');
    expect(echoedTenant(res.output)).toBe(OTHER_TENANT); // caller value ignored
  });

  it('runs a default-tenant flow as the default tenant (positive control)', async () => {
    const flowId = await makeFlow(db, DEFAULT_TENANT, 'manual');
    created.push(flowId);
    const res = await executeFlow(db, flowId);
    expect(echoedTenant(res.output)).toBe(DEFAULT_TENANT);
  });

  it('a write fires only the writing tenant’s flows', async () => {
    const mineFlow = await makeFlow(db, DEFAULT_TENANT, 'on_create', {
      collection: PROBE_COLLECTION,
    });
    const foreignFlow = await makeFlow(db, OTHER_TENANT, 'on_create', {
      collection: PROBE_COLLECTION,
    });
    created.push(mineFlow, foreignFlow);

    // A write in the DEFAULT tenant must only fire the DEFAULT tenant's flow.
    await withTenantIsolation(DEFAULT_TENANT, (trx) =>
      enqueueChangeEvent(trx, DEFAULT_TENANT, {
        id: crypto.randomUUID(),
        event: 'insert',
        collection: PROBE_COLLECTION,
        data: { id: 'x' },
        timestamp: new Date().toISOString(),
      }),
    );
    await drainFlowJobs(db);

    const countRuns = async (flowId: string): Promise<number> => {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_flow_runs WHERE flow_id = ${flowId}
      `.execute(db);
      return r.rows[0]!.n;
    };
    expect(await countRuns(mineFlow)).toBeGreaterThan(0); // fired
    expect(await countRuns(foreignFlow)).toBe(0); // NOT fired
  });
});
