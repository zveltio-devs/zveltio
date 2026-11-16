/**
 * LV-01 (DR-03): the engine's background work reaches its firm under the closed
 * default — no tenant context, no tenant's rows — on the connection the
 * documented install runs as, the NOSUPERUSER NOBYPASSRLS owner.
 *
 * The harness never runs `index.ts`'s `bootstrap()`, so the live check found
 * boot, cron, the pg-boss pollers and the runner uncovered there. Each is driven
 * here through the function that wiring calls, for a firm that is NOT the root
 * one: a path that leaned on the old fallback (no tenant = the root firm) would
 * miss it twice over. Each either names the firm it works for or reaches every
 * firm through `withEveryTenant` / `publishEveryTenant`.
 *
 * The extension cron runner's per-firm runs are pinned by
 * extension-schedule-per-tenant.test.ts (the handler as `_runOne` calls it), the
 * extension job runner's by ext-job-runner.test.ts; both run on this lane.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { flowScheduler } from '../../lib/flows/flow-scheduler.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { enqueueChangeEvent, repairUnsignedWebhooksAtBoot } from '../../lib/webhooks.js';
import {
  asEveryTenant,
  asTenant,
  connectedAsSuperuser,
  drainFlowJobs,
  drainWebhookJobs,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FIRM = crypto.randomUUID();
const STAMP = `lv01_${Date.now()}`;
const C = `${STAMP}_c`;
// The run's firm, as the executor set it for the step.
const ECHO_TENANT = { query: "SELECT current_setting('zveltio.current_tenant', true) AS tenant" };

d('background work reaches its firm under the closed tenant default (LV-01)', () => {
  let db: Database;
  let originalFetch: typeof fetch;

  const flow = async (trigger: 'cron' | 'on_create', config: Record<string, unknown>) => {
    const id = await asTenant(db, FIRM, async (trx) => {
      const r = await sql<{ id: string }>`
        INSERT INTO zv_flows (tenant_id, name, trigger_type, trigger_config, is_active, next_run_at)
        VALUES (${FIRM}::uuid, ${`${STAMP}-${trigger}`}, ${trigger}, ${JSON.stringify(config)}::jsonb,
                true, ${trigger === 'cron' ? new Date(Date.now() - 60_000) : null})
        RETURNING id::text AS id`.execute(trx);
      return r.rows[0]!.id;
    });
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${id}, 0, 'echo', 'query_db', ${JSON.stringify(ECHO_TENANT)}::jsonb, 'stop')
    `.execute(db);
    return id;
  };
  /** The firms the flow's runs ran as, from the echo step's output. */
  const runsOf = async (flowId: string) =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ status: string; tenant: string | null }>`
          SELECT status, output->0->>'tenant' AS tenant FROM zv_flow_runs
           WHERE flow_id = ${flowId}::uuid`.execute(trx),
      )
    ).rows;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${FIRM}::uuid, ${STAMP}, ${STAMP}, 'active')`.execute(db);
    await DDLManager.createCollection(db, {
      name: C,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, status: 200, text: async () => 'ok' }) as Response) as unknown as typeof fetch;
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    flowScheduler.stop();
    if (!db) return;
    await asEveryTenant(db, async (trx) => {
      await sql`DELETE FROM zv_flows WHERE name LIKE ${`${STAMP}%`}`.execute(trx);
      await sql`DELETE FROM zvd_webhook_deliveries WHERE webhook_id IN (
                  SELECT id FROM zvd_webhooks WHERE name LIKE ${`${STAMP}%`})`.execute(trx);
      await sql`DELETE FROM zvd_webhooks WHERE name LIKE ${`${STAMP}%`}`.execute(trx);
    });
    await dropTestCollection(db, C).catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${FIRM}::uuid`.execute(db);
  });

  it('the bare pool sees none of the firm’s rows on this connection', async () => {
    await asTenant(db, FIRM, (trx) =>
      sql`INSERT INTO zv_flows (tenant_id, name, trigger_type, is_active)
          VALUES (${FIRM}::uuid, ${`${STAMP}-probe`}, 'manual', false)`.execute(trx),
    );
    const bare = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_flows WHERE name = ${`${STAMP}-probe`}`.execute(db);
    // A superuser lane bypasses RLS, and with it what this file is about.
    expect(bare.rows[0]!.n).toBe((await connectedAsSuperuser(db)) ? 1 : 0);
  });

  it('boot: an unsigned webhook of another firm is given its secret', async () => {
    await asTenant(db, FIRM, (trx) =>
      sql`INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, secret)
          VALUES (${FIRM}::uuid, ${`${STAMP}-unsigned`}, 'https://93.184.216.34/lv01',
                  ARRAY['insert']::text[], ARRAY['nothing']::text[], NULL)`.execute(trx),
    );
    expect(await repairUnsignedWebhooksAtBoot(db)).toBeGreaterThanOrEqual(1);
    const row = await asEveryTenant(db, (trx) =>
      sql<{ signed: boolean }>`
        SELECT secret IS NOT NULL AS signed FROM zvd_webhooks
         WHERE name = ${`${STAMP}-unsigned`}`.execute(trx),
    );
    expect(row.rows).toEqual([{ signed: true }]);
  });

  it('cron: the flow scheduler, as boot starts it, runs another firm’s due flow as that firm', async () => {
    const id = await flow('cron', { cron: '0 3 * * *' });
    // `start` ticks once before it returns, as at boot; `stop` drops the timers.
    await flowScheduler.start(db);
    flowScheduler.stop();
    expect(await runsOf(id)).toEqual([{ status: 'success', tenant: FIRM }]);
    const next = await asEveryTenant(db, (trx) =>
      sql<{ later: boolean }>`
        SELECT next_run_at > now() AS later FROM zv_flows WHERE id = ${id}::uuid`.execute(trx),
    );
    expect(next.rows).toEqual([{ later: true }]);
  }, 30_000);

  it('pg-boss: a firm’s write reaches its webhook delivery and its flow run, in that firm', async () => {
    const hook = await asTenant(db, FIRM, async (trx) => {
      const r = await sql<{ id: string }>`
        INSERT INTO zvd_webhooks (tenant_id, name, url, events, collections, retry_attempts)
        VALUES (${FIRM}::uuid, ${`${STAMP}-hook`}, 'https://93.184.216.34/lv01',
                ARRAY['insert']::text[], ARRAY[${C}]::text[], 1)
        RETURNING id::text AS id`.execute(trx);
      return r.rows[0]!.id;
    });
    const triggered = await flow('on_create', { collection: C });
    await withTenantIsolation(FIRM, (trx) =>
      enqueueChangeEvent(trx, FIRM, {
        id: crypto.randomUUID(),
        event: 'insert',
        collection: C,
        data: { id: crypto.randomUUID(), title: 'lv01' },
        timestamp: new Date().toISOString(),
      }),
    );
    // The functions the workers' `boss.work` callbacks run, claimed through pg-boss.
    await drainWebhookJobs(db);
    await drainFlowJobs(db);
    const deliveries = await asEveryTenant(db, (trx) =>
      sql<{ tenant: string; delivered: boolean }>`
        SELECT tenant_id::text AS tenant, delivered_at IS NOT NULL AS delivered
          FROM zvd_webhook_deliveries WHERE webhook_id = ${hook}::uuid`.execute(trx),
    );
    expect(deliveries.rows).toEqual([{ tenant: FIRM, delivered: true }]);
    expect(await runsOf(triggered)).toEqual([{ status: 'success', tenant: FIRM }]);
  }, 30_000);
});
