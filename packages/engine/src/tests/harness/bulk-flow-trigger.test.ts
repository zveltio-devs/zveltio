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
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

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
      SELECT count(*)::int AS n FROM zv_flow_runs WHERE flow_id = ${flowId}::uuid
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
    await Bun.sleep(700);
    expect(await runsFor()).toBeGreaterThan(before);
  }, 30_000);

  it('a bulk create fires it too', async () => {
    const before = await runsFor();
    const res = await app.request(`/api/data/${coll}/bulk`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ n: 2 }, { n: 3 }] }),
    });
    expect(res.status).toBe(201);
    await Bun.sleep(900);
    // Two records, so at least two runs — and more importantly, more than none.
    expect(await runsFor()).toBeGreaterThan(before);
  }, 30_000);
});
