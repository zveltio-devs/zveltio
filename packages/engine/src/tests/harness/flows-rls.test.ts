/**
 * `zv_flows` is isolated by Postgres, not only by `/api/flows`.
 *
 * The table carries `tenant_id` and had no policy, so a reader that does not
 * filter by it — a whitelisted RPC function — saw every firm's flows. Migration
 * 027 puts it under the tenant policy.
 *
 * A policy alone would have broken every reader that runs outside a tenant
 * transaction, and on a non-superuser database they answer for the default firm
 * only: the scheduler's claim (every firm's due flows, one transaction), the
 * executor's lookup of which firm a flow runs as, the record-hook lookup and the
 * routes. The harness pool is a superuser, where no policy binds, so the
 * background paths are driven here through a pool whose every connection is
 * `zveltio_rls` — what a correctly provisioned install connects as.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { Kysely, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import type { DbSchema } from '../../db/schema.js';
import { triggerDataFlows } from '../../lib/flows/index.js';
import { flowScheduler } from '../../lib/flows/flow-scheduler.js';
import { executeFlow } from '../../lib/flows/flow-executor.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { getCurrentTenantTrx, withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `flrls-${OTHER.slice(0, 8)}`;
const STAMP = `flrls_${Date.now()}`;
const FN = 'harness_flows_rls_rows';
const ECHO = { query: "SELECT current_setting('zveltio.current_tenant', true) AS tenant" };

/** The harness URL, every connection opened as the plain role. */
function plainRoleUrl(): string {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c role=zveltio_rls');
  return url.toString();
}

d('zv_flows under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let plain: Database;
  let god = '';
  const raw: Record<string, string> = {};

  const headers = (tenant: string, extra: Record<string, string>) => ({
    'Content-Type': 'application/json',
    ...extra,
    ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
  });

  async function seedFlow(
    tenant: string,
    tag: string,
    trigger: 'cron' | 'on_create',
    config: Record<string, unknown>,
  ): Promise<string> {
    const row = await sql<{ id: string }>`
      INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active, next_run_at)
      VALUES (${tenant}::uuid, ${`${STAMP}-${tag}`}, ${trigger}, ${JSON.stringify(config)}::jsonb,
              true, now() - interval '1 minute')
      RETURNING id::text AS id`.execute(db);
    const id = row.rows[0]!.id;
    await sql`INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config)
              VALUES (${id}, 0, 'echo', 'query_db', ${JSON.stringify(ECHO)}::jsonb)`.execute(db);
    return id;
  }

  async function runsOf(flowId: string) {
    const r = await sql<{ status: string; output: unknown }>`
      SELECT status, output FROM zv_flow_runs WHERE flow_id = ${flowId}::uuid`.execute(db);
    return r.rows.map((x) => ({
      status: x.status,
      tenant: (x.output as { tenant?: string }[] | null)?.[0]?.tenant,
    }));
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    plain = new Kysely<DbSchema>({
      dialect: new BunSqlDialect({ connectionString: plainRoleUrl(), max: 4 }),
    }) as unknown as Database;
    const { userId } = await createMemberSession(app, db);
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zv_flows (name, tenant_id, trigger_type)
                VALUES (${`${STAMP}-seed`}, ${tenant}::uuid, 'manual')`.execute(db);
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([{ collection: '$rpc', actions: ['execute'] }])}::jsonb, true,
                ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT tenant_id FROM zv_flows WHERE name = '${STAMP}-seed'
            $$`)
      .execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${FN}, 'member', true)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    flowScheduler.stop();
    await plain?.destroy().catch(() => undefined);
    if (!db) return;
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zv_flows WHERE name LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s flows', async () => {
    for (const tenant of [OTHER, ROOT]) {
      const res = await app.request(`/api/rpc/${FN}`, {
        method: 'POST',
        headers: headers(tenant, { 'X-API-Key': raw[tenant]! }),
        body: '{}',
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { tenant_id: string }[] };
      expect(data.map((r) => r.tenant_id)).toEqual([tenant]);
    }
  });

  it('the scheduler fires every firm’s due flow, each as its own firm', async () => {
    const mine = await seedFlow(ROOT, 'cron-root', 'cron', { cron: '0 3 * * *' });
    const theirs = await seedFlow(OTHER, 'cron-other', 'cron', { cron: '0 3 * * *' });

    await flowScheduler.start(plain);
    flowScheduler.stop(); // drop the timers, keep the handle
    await flowScheduler._tick();

    expect(await runsOf(mine)).toEqual([{ status: 'success', tenant: ROOT }]);
    expect(await runsOf(theirs)).toEqual([{ status: 'success', tenant: OTHER }]);
    // The advance is a write under WITH CHECK: it has to be made as the row's firm.
    const next = await sql<{ id: string; later: boolean }>`
      SELECT id::text AS id, next_run_at > now() AS later FROM zv_flows
       WHERE id IN (${mine}::uuid, ${theirs}::uuid)`.execute(db);
    expect(next.rows.every((r) => r.later)).toBe(true);
  }, 30_000);

  it('a record hook fires the writing firm’s flow', async () => {
    const collection = `${STAMP}_hook`;
    const flow = await seedFlow(OTHER, 'hook', 'on_create', { collection });
    await triggerDataFlows(plain, collection, 'insert', { id: 'r1' }, OTHER);
    let runs: Awaited<ReturnType<typeof runsOf>> = [];
    for (let i = 0; i < 50 && runs.every((r) => r.status === 'running'); i++) {
      await Bun.sleep(100);
      runs = await runsOf(flow);
    }
    expect(runs).toEqual([{ status: 'success', tenant: OTHER }]);
  }, 30_000);

  it('the flow routes create, list, edit, run and delete in a non-default firm', async () => {
    const create = await app.request('/api/flows', {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({
        name: `${STAMP}-route`,
        trigger: { type: 'manual' },
        steps: [{ type: 'query_db', config: ECHO }],
      }),
    });
    expect(create.status).toBe(201);
    const { flow } = (await create.json()) as {
      flow: { id: string; tenant_id: string; steps: unknown[] };
    };
    expect(flow.tenant_id).toBe(OTHER);
    expect(flow.steps).toHaveLength(1);

    const listed = async (tenant: string) => {
      const res = await app.request('/api/flows?limit=200', {
        headers: headers(tenant, { cookie: god }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { flows: { name: string }[] };
      return body.flows.map((x) => x.name).filter((n) => n.startsWith(`${STAMP}-`));
    };
    expect((await listed(OTHER)).sort()).toEqual([
      `${STAMP}-cron-other`,
      `${STAMP}-hook`,
      `${STAMP}-route`,
      `${STAMP}-seed`,
    ]);
    expect((await listed(ROOT)).sort()).toEqual([`${STAMP}-cron-root`, `${STAMP}-seed`]);

    const patch = await app.request(`/api/flows/${flow.id}`, {
      method: 'PATCH',
      headers: headers(OTHER, { cookie: god }),
      body: JSON.stringify({ name: `${STAMP}-route2` }),
    });
    expect(patch.status).toBe(200);

    const run = await app.request(`/api/flows/${flow.id}/run`, {
      method: 'POST',
      headers: headers(OTHER, { cookie: god }),
      body: '{}',
    });
    expect(run.status).toBe(202);
    let runs: { id: string; status: string }[] = [];
    for (let i = 0; i < 50 && !runs.some((r) => r.status === 'success'); i++) {
      await Bun.sleep(100);
      const res = await app.request(`/api/flows/${flow.id}/runs`, {
        headers: headers(OTHER, { cookie: god }),
      });
      runs = ((await res.json()) as { runs: typeof runs }).runs;
    }
    expect(runs.map((r) => r.status)).toEqual(['success']);
    const detail = await app.request(`/api/flows/runs/${runs[0]!.id}`, {
      headers: headers(OTHER, { cookie: god }),
    });
    expect(detail.status).toBe(200);

    const elsewhere = await app.request(`/api/flows/${flow.id}`, {
      headers: headers(ROOT, { cookie: god }),
    });
    expect(elsewhere.status).toBe(404);

    const del = await app.request(`/api/flows/${flow.id}`, {
      method: 'DELETE',
      headers: headers(OTHER, { cookie: god }),
    });
    expect(del.status).toBe(200);
  }, 30_000);

  it('an ai_task flow hands the AI extension its own firm’s transaction', async () => {
    // What the `ai` extension's `ctx.db` resolves: the job's tenant transaction,
    // else the pool — which, with no GUC, answers for the default firm.
    const seen: { tenant: string | null; flows: number }[] = [];
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => {
      const q = getCurrentTenantTrx() ?? plain;
      const r = await sql<{ tenant: string | null; flows: number }>`
        SELECT current_setting('zveltio.current_tenant', true) AS tenant,
               (SELECT count(*)::int FROM zv_flows WHERE id = ${aiFlow}::uuid) AS flows
      `.execute(q);
      seen.push(r.rows[0]!);
    });
    // `ai_task` is admitted by the `ai` extension's migration, which widens the
    // CHECK. Widen it the same way here and put the original back afterwards.
    const check = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'zv_flows_trigger_type_check'`.execute(db);
    await sql`ALTER TABLE zv_flows DROP CONSTRAINT IF EXISTS zv_flows_trigger_type_check`.execute(
      db,
    );
    const aiFlow = await seedFlow(OTHER, 'ai', 'cron', {});
    await sql`UPDATE zv_flows SET trigger_type = 'ai_task' WHERE id = ${aiFlow}::uuid`.execute(db);
    try {
      await flowScheduler.start(plain);
      flowScheduler.stop();
      await flowScheduler._tick();
    } finally {
      serviceRegistry.unregisterAs('test', 'ai.runBackgroundTask');
      await sql`DELETE FROM zv_flows WHERE id = ${aiFlow}::uuid`.execute(db);
      if (check.rows[0]) {
        await sql
          .raw(
            `ALTER TABLE zv_flows ADD CONSTRAINT zv_flows_trigger_type_check ${check.rows[0].def}`,
          )
          .execute(db);
      }
    }
    expect(seen).toEqual([{ tenant: OTHER, flows: 1 }]);
  }, 30_000);

  it('a suspended firm’s due flow is neither run nor advanced, and runs once when reactivated', async () => {
    const SUSP = crypto.randomUUID();
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${SUSP}::uuid, ${`flsusp-${SUSP.slice(0, 8)}`}, 'susp', 'suspended')`.execute(
      db,
    );
    try {
      const flow = await seedFlow(SUSP, 'suspended', 'cron', { cron: '0 3 * * *' });
      const nextRun = async () =>
        (
          await sql<{ at: string }>`SELECT next_run_at::text AS at FROM zv_flows
                                     WHERE id = ${flow}::uuid`.execute(db)
        ).rows[0]!.at;
      const before = await nextRun();

      await flowScheduler.start(plain);
      flowScheduler.stop();
      await flowScheduler._tick();
      expect(await runsOf(flow)).toEqual([]);
      expect(await nextRun()).toBe(before);

      await sql`UPDATE zv_tenants SET status = 'active' WHERE id = ${SUSP}::uuid`.execute(db);
      await flowScheduler._tick();
      await flowScheduler._tick();
      expect(await runsOf(flow)).toEqual([{ status: 'success', tenant: SUSP }]);
    } finally {
      await sql`DELETE FROM zv_tenants WHERE id = ${SUSP}::uuid`.execute(db);
    }
  }, 30_000);

  it('a flow whose firm the executor cannot see fails instead of running as the default firm', async () => {
    // A firm that is no longer in `zv_tenants` is outside every reach.
    const flow = await seedFlow(crypto.randomUUID(), 'orphan', 'on_create', {});
    const result = await executeFlow(plain, flow, {});
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/cannot resolve the tenant/);
    const runs = await sql<{ status: string; error: string | null; output: unknown }>`
      SELECT status, error, output FROM zv_flow_runs WHERE flow_id = ${flow}::uuid`.execute(db);
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]!.status).toBe('failed');
    expect(runs.rows[0]!.error).toMatch(/refusing to run it as the default tenant/);
  }, 30_000);

  it('a firm cannot write a flow into another firm', async () => {
    const write = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_flows (name, tenant_id) VALUES (${`${STAMP}-x`}, ${ROOT}::uuid)`.execute(
        trx,
      ),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });
});
