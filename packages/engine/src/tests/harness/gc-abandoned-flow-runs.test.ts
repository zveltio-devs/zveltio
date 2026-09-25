/**
 * The nightly GC fails flow runs left in 'running'.
 *
 * A run is marked done by the process executing it. When that process died
 * mid-run, or its final UPDATE failed (flow-executor-bookkeeping-warn), the row
 * said 'running' forever: nothing ever swept it, and the run list showed a flow
 * still executing days later.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { runGarbageCollector } from '../../lib/runtime/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('runGarbageCollector — abandoned flow runs', () => {
  let db: Database;
  let flowId = '';

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const flow = await sql<{ id: string }>`
      INSERT INTO zv_flows (name, trigger_type, trigger_config, is_active)
      VALUES (${`gc-abandoned-${Date.now()}`}, 'manual', '{}'::jsonb, true)
      RETURNING id::text AS id
    `.execute(db);
    flowId = flow.rows[0]!.id;
  });

  afterAll(async () => {
    if (db) await sql`DELETE FROM zv_flows WHERE id = ${flowId}`.execute(db);
  });

  async function insertRun(status: string, startedHoursAgo: number): Promise<string> {
    const r = await sql<{ id: string }>`
      INSERT INTO zv_flow_runs (flow_id, status, started_at)
      VALUES (${flowId}, ${status}, NOW() - (${startedHoursAgo}::int || ' hours')::interval)
      RETURNING id::text AS id
    `.execute(db);
    return r.rows[0]!.id;
  }

  it('fails an old running run, leaves a recent one and finished ones alone', async () => {
    const abandoned = await insertRun('running', 7);
    const live = await insertRun('running', 0);
    const done = await insertRun('success', 30);

    await runGarbageCollector(db);

    const rows = await sql<{ id: string; status: string; error: string | null; fin: boolean }>`
      SELECT id::text AS id, status, error, finished_at IS NOT NULL AS fin
      FROM zv_flow_runs WHERE flow_id = ${flowId}
    `.execute(db);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));

    expect(byId.get(abandoned)).toMatchObject({ status: 'failed', fin: true });
    expect(byId.get(abandoned)!.error).toContain('abandoned');
    expect(byId.get(live)).toMatchObject({ status: 'running', fin: false });
    expect(byId.get(done)!.status).toBe('success');
  });
});
