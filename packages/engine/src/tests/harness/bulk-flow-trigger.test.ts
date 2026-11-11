/**
 * A record created in a batch fires its automations, like one created alone.
 *
 * `afterWrite` hands the request's transaction to `triggerDataFlows`, and the
 * bulk handlers called it WITHOUT awaiting. The un-awaited call raced the commit
 * and lost: every bulk create logged `trigger "insert" … did not run its
 * automations: Transaction is already committed`, while the same write through
 * `POST /api/data/:collection` and through `PATCH` was clean.
 *
 * So automations never fired for records created in a batch — precisely when an
 * import or a sync uses this endpoint, while the single-record case an operator
 * tries first works. The failure announced itself in the log and nowhere else.
 *
 * This asserts a flow RUN row rather than the absence of a log line: a test that
 * greps stderr passes the day someone changes the wording.
 *
 * And a SUCCESSFUL run, not just a run row. The flow was started on the request's
 * transaction without being awaited, so the row went in while the transaction
 * was open and everything after it — loading the steps, marking the run done —
 * met `Transaction is already committed`, even the attempt to mark it failed.
 * Every data-triggered run stayed `running` for good, while a count of rows
 * went up and passed.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { runFlowJob } from '../../lib/flows/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/route-db.js';
import {
  createGodSession,
  drainFlowJobs,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('bulk writes fire their automations (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const tag = crypto.randomUUID().slice(0, 8);
  const coll = `probe_bflow_${tag}`;
  let flowId = '';

  // The hook does real DDL through a queue; the default 5 s is not its budget.
  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const made = await app.request('/api/collections', {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: coll,
        display_name: coll,
        fields: [{ name: 'n', type: 'number' }],
      }),
    });
    expect([200, 201, 202]).toContain(made.status);

    // Wait for the TABLE, not for a duration.
    //
    // Collection creation answers 202 and the DDL runs on a queue, so a fixed
    // sleep is a guess about someone else's scheduler. At 600 ms this hook
    // failed at exactly 5000 ms — bun's default — on a loaded machine while
    // passing in CI, which is the shape of a test that will fail for everyone
    // eventually and for nobody reproducibly.
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${`zvd_${coll}`}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (name, trigger_type, trigger_config, is_active)
      VALUES (${`probe-flow-${tag}`}, 'on_create', ${JSON.stringify({ collection: coll })}::jsonb, true)
      RETURNING id::text AS id
    `.execute(db);
    flowId = flow.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (flowId) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${flowId}::uuid`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${flowId}::uuid`.execute(db).catch(() => {});
    }
    await sql`DROP TABLE IF EXISTS ${sql.table(`zvd_${coll}`)}`.execute(db).catch(() => {});
    await sql`DELETE FROM zvd_collections WHERE name = ${coll}`.execute(db).catch(() => {});
  });

  async function runsFor(): Promise<number> {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_flow_runs
       WHERE flow_id = ${flowId}::uuid AND status = 'success'
    `.execute(db);
    return r.rows[0]!.n;
  }

  it('a single create fires the flow — the control', async () => {
    const before = await runsFor();
    const res = await app.request(`/api/data/${coll}`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(201);
    await drainFlowJobs(db);
    expect(await runsFor()).toBe(before + 1);
  }, 30_000);

  it('a bulk create fires it too', async () => {
    const before = await runsFor();
    const res = await app.request(`/api/data/${coll}/bulk`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ n: 2 }, { n: 3 }] }),
    });
    expect(res.status).toBe(201);
    await drainFlowJobs(db);
    // One run per record: each is its own event.
    expect(await runsFor()).toBe(before + 2);
  }, 30_000);

  // ADR 0035 decision 6: the run row is keyed by (flow, event).
  const redeliver = (eventId: string) =>
    runFlowJob({
      data: {
        tenantId: DEFAULT_TENANT_ID,
        flowId,
        eventId,
        sequence: 1,
        event: 'insert',
        collection: coll,
        data: {},
        timestamp: new Date().toISOString(),
      },
    });

  it('a trigger job delivered again does not run the flow again', async () => {
    const run = await sql<{ event_id: string }>`
      SELECT event_id::text AS event_id FROM zv_flow_runs
       WHERE flow_id = ${flowId}::uuid AND event_id IS NOT NULL LIMIT 1
    `.execute(db);
    const before = await runsFor();
    await redeliver(run.rows[0]!.event_id);
    expect(await runsFor()).toBe(before);
  });

  it('a run its process died in is marked interrupted, not run again', async () => {
    const eventId = crypto.randomUUID();
    await sql`
      INSERT INTO zv_flow_runs (flow_id, status, trigger_data, event_id)
      VALUES (${flowId}::uuid, 'running', '{}'::jsonb, ${eventId}::uuid)
    `.execute(db);
    await redeliver(eventId);
    const after = await sql<{ status: string; error: string | null }>`
      SELECT status, error FROM zv_flow_runs
       WHERE flow_id = ${flowId}::uuid AND event_id = ${eventId}::uuid
    `.execute(db);
    expect(after.rows).toEqual([{ status: 'failed', error: 'interrupted' }]);
  });
});
