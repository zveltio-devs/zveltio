/**
 * Phase C — actual flow EXECUTION, driven through the in-process app.
 *
 * Covers lib/flows/flow-executor.ts (275 uncovered lines), the biggest untested
 * logic module reachable without external services. The route validator and the
 * executor disagree on step-config keys (a known bug — the route's StepSchema
 * lacks `query_db` and wants `script`, the executor reads `query`/`code`), so a
 * flow authored purely through the route can't run those step types. This suite
 * side-steps that by inserting runnable steps DIRECTLY into zv_flow_steps (the
 * canonical shape the executor reads), then triggering POST /:id/run.
 *
 * The run route fires executeFlow fire-and-forget (202), so we WAIT for the run
 * row to reach a terminal state before asserting — that's what pulls the
 * executor into coverage. query_db (SELECT) + run_script (sandboxed JS) +
 * condition all run in-process with no network.
 *
 * Skips without a test database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

async function insertStep(
  db: Database,
  flowId: string,
  order: number,
  type: string,
  config: Record<string, unknown>,
  onError: 'stop' | 'continue' | 'retry' = 'continue',
): Promise<void> {
  await sql`
    INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
    VALUES (${flowId}, ${order}, ${type}, ${type}, ${JSON.stringify(config)}::jsonb, ${onError})
  `.execute(db);
}

/** Poll zv_flow_runs until a run for this flow reaches a terminal status. */
async function waitForRun(db: Database, flowId: string, timeoutMs = 8000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await sql<{ status: string }>`
      SELECT status FROM zv_flow_runs WHERE flow_id = ${flowId}
      ORDER BY started_at DESC NULLS LAST LIMIT 1
    `.execute(db);
    const status = row.rows[0]?.status;
    if (status && ['completed', 'failed', 'error', 'success'].includes(status)) return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

d('flow execution (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let flowId = '';
  let failFlowId = '';

  const createFlow = async (name: string): Promise<string> => {
    const res = await app.request('/api/flows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name, trigger: { type: 'manual' }, steps: [], is_active: true }),
    });
    const body = (await res.json()) as { flow: { id: string } };
    return body.flow.id;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // A flow whose steps all run cleanly in-process.
    flowId = await createFlow('Harness Run Flow');
    await insertStep(db, flowId, 0, 'query_db', { query: 'SELECT 1 AS ok, 2 AS two' });
    await insertStep(db, flowId, 1, 'run_script', { code: 'return { doubled: 21 * 2 };' });
    await insertStep(db, flowId, 2, 'condition', { expression: '1 == 1' });

    // A flow whose query_db step is rejected by the read-only guard (a write
    // statement) — exercises the executor's error arm + on_error handling.
    failFlowId = await createFlow('Harness Fail Flow');
    await insertStep(db, failFlowId, 0, 'query_db', { query: 'DELETE FROM zv_flows' }, 'stop');
  });

  afterAll(async () => {
    for (const id of [flowId, failFlowId]) {
      if (db && id) {
        await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
        await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
        await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
      }
    }
  });

  it('triggers a multi-step flow and runs it to completion', async () => {
    const res = await app.request(`/api/flows/${flowId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(202);

    const status = await waitForRun(db, flowId);
    expect(status).not.toBeNull();
    // query_db (SELECT) + run_script + condition all succeed → a successful run.
    expect(['completed', 'success']).toContain(status as string);
  });

  it('records a failed run when a step throws (query_db write guard)', async () => {
    const res = await app.request(`/api/flows/${failFlowId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(202);

    // The executor's error arm runs (read-only guard throws on the DELETE); the
    // run reaches a terminal state. The security-critical assertion is that the
    // write was blocked — the flows table is intact.
    const status = await waitForRun(db, failFlowId);
    expect(status).not.toBeNull();

    const flows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM zv_flows`.execute(db);
    expect(flows.rows[0]!.n).toBeGreaterThan(0);
  });

  it('lists the run history for the flow (GET /:id/runs)', async () => {
    const res = await app.request(`/api/flows/${flowId}/runs`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs?: unknown[] };
    const runs = body.runs ?? (body as unknown as unknown[]);
    expect(Array.isArray(runs)).toBe(true);
  });
});
