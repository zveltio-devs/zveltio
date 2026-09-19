/**
 * `zv_flow_runs.trigger_data` and `.output` were written as
 * `${JSON.stringify(v)}::jsonb`, which stores a jsonb STRING: `jsonb_typeof`
 * answers `string` and `output->>'field'` is NULL. `lib/jsonb.ts` documents
 * that exact form as the trap and `routes/flows.ts` already used the helper —
 * the executor next door did not.
 *
 * Measured on a real run before the repair: `trigger_data=string`,
 * `output=string`, `trigger_data->>'marker'` NULL.
 */
import { expect, it } from 'bun:test';
import { sql } from 'kysely';
import { executeFlow } from '../../lib/flows/flow-executor.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

it.skipIf(!harnessAvailable())(
  'a run row holds real jsonb, so the trigger data can be queried',
  async () => {
    const { db } = await getTestApp();
    const flowId = crypto.randomUUID();
    await db
      .insertInto('zv_flows' as never)
      .values({
        id: flowId,
        name: 'jsonb shape probe',
        trigger_type: 'manual',
        trigger_config: JSON.stringify({}),
        is_active: true,
      } as never)
      .execute();
    await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config)
      VALUES (${flowId}, 1, 'probe step', 'query_db',
              ${JSON.stringify({ query: 'SELECT 1 AS one' })}::text::jsonb)
    `.execute(db);

    try {
      const run = await executeFlow(db, flowId, { trigger: 'probe', marker: 'M1' });
      expect(run.status).toBe('success');
      const row = await sql<{ t: string; o: string; marker: string | null }>`
        SELECT jsonb_typeof(trigger_data) AS t,
               jsonb_typeof(output)       AS o,
               trigger_data->>'marker'    AS marker
        FROM zv_flow_runs WHERE id = ${run.runId}
      `.execute(db);
      // The `->>` is the assertion that matters: it is NULL on a jsonb string
      // whatever `jsonb_typeof` says, and it is what every report reading a run
      // actually does.
      expect(row.rows[0]!.marker).toBe('M1');
      expect(row.rows[0]!.t).toBe('object');
      expect(row.rows[0]!.o).not.toBe('string');
    } finally {
      await db.deleteFrom('zv_flows').where('id', '=', flowId).execute();
    }
  },
  30_000,
);
