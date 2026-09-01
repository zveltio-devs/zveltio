/**
 * C-6 — a step type the executor does not implement must fail the run, not
 * report success.
 *
 * The `default` arm returned `{ output: prevOutput }`: the step passed the
 * previous output through and the run was recorded successful. So "when an
 * invoice is created → if total > 10,000 → create an approval" ran green and
 * did nothing, and the run history said it worked.
 *
 * The three types here are the ones that are actually STORABLE and never
 * execute. There is a CHECK constraint on `zv_flow_steps.type` that the audit
 * did not account for and neither did I until this file failed: it admits nine
 * types, the executor implements seven, and the two sets are not nested.
 * `create_record` and `update_record` — named in the audit — cannot be stored
 * at all, so they were never live no-ops. `transform` and `delay` are, and were
 * in nobody's list.
 *
 * Four lists then, all different, none compared to another: the CHECK, the
 * executor's switch, `flow-step-schemas.ts`, and what the Studio offers.
 *
 * Steps are inserted straight into `zv_flow_steps` rather than through the API,
 * because the API refuses these types now. That is the case worth testing:
 * flows already stored on installs that have been running them for months.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('unimplemented flow step (in-process)', () => {
  let db: Database;
  const flowIds: string[] = [];

  async function makeFlow(stepType: string): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO zv_flows (name, trigger_type, is_active)
      VALUES (${`c6-${stepType}-${Date.now()}`}, 'manual', true)
      RETURNING id
    `.execute(db);
    const id = rows[0]!.id;
    flowIds.push(id);
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
      VALUES (${id}, 0, ${stepType}, ${stepType}, '{}'::jsonb, 'stop')
    `.execute(db);
    return id;
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    // Migration 042 narrowed the CHECK on `zv_flow_steps.type` to what the
    // executor implements, so these rows can no longer be created. Dropping it
    // for the duration reproduces a pre-migration install exactly — which is
    // the population this test is about: flows already stored and running.
    await sql`ALTER TABLE zv_flow_steps DROP CONSTRAINT IF EXISTS zv_flow_steps_type_check`.execute(
      db,
    );
  });

  afterAll(async () => {
    await sql`
      ALTER TABLE zv_flow_steps ADD CONSTRAINT zv_flow_steps_type_check
      CHECK (type IN ('query_db','run_script','send_email','webhook',
                      'send_notification','export_collection','ai_decision')) NOT VALID
    `
      .execute(db)
      .catch(() => {});
    for (const id of flowIds) {
      await sql`DELETE FROM zv_flow_runs WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flow_steps WHERE flow_id = ${id}`.execute(db).catch(() => {});
      await sql`DELETE FROM zv_flows WHERE id = ${id}`.execute(db).catch(() => {});
    }
  });

  it.each(['condition', 'transform', 'delay'])(
    'fails the run on a %s step instead of reporting success',
    async (stepType) => {
      const flowId = await makeFlow(stepType);
      const result = await executeFlow(db, flowId, {});

      expect(result.status).toBe('failed');
      // Naming the type matters: the operator has to know WHICH step is the
      // problem, and "not implemented" is the fact they need to act on.
      expect(result.error ?? '').toContain(stepType);
      expect(result.error ?? '').toMatch(/not implemented/i);
    },
  );

  it('records the failure in the run history', async () => {
    const flowId = await makeFlow('condition');
    await executeFlow(db, flowId, {});

    const { rows } = await sql<{ status: string }>`
      SELECT status FROM zv_flow_runs WHERE flow_id = ${flowId}
      ORDER BY started_at DESC NULLS LAST LIMIT 1
    `.execute(db);
    // The half that mattered most: the run history said "success" for a flow
    // that had done nothing, so nobody had any reason to look at it.
    expect(rows[0]?.status).toBe('failed');
  });

  it('still runs a flow whose steps ARE implemented', async () => {
    // Positive control. A `default` arm that threw for everything would pass
    // every assertion above while breaking every real flow on the instance.
    const flowId = await makeFlow('query_db');
    await sql`UPDATE zv_flow_steps SET config = ${JSON.stringify({
      query: 'SELECT 1 AS ok',
    })}::jsonb WHERE flow_id = ${flowId}`.execute(db);

    const result = await executeFlow(db, flowId, {});
    expect(result.status).toBe('success');
  });
});
