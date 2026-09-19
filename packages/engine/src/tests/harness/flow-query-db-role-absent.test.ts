/**
 * `query_db` drops to `zveltio_flow_reader` and, when that role is unavailable,
 * is documented to fall back to the instance-admin gate on authorship — "the
 * honest degradation", says the comment.
 *
 * It was not a fallback. A failed `SET LOCAL ROLE` ABORTS the transaction in
 * Postgres, so catching the JS error changed nothing: the two statements after
 * it came back `25P02 current transaction is aborted`, and every `query_db` step
 * failed outright on an install whose Postgres could not create the role
 * (migration 024 names managed Postgres as exactly that case). Measured: the
 * step returned `status: failed` with that SQLSTATE.
 *
 * The repair is a SAVEPOINT around the SET. This test points the role name at a
 * role that does not exist, because the engine connects as a superuser — absence
 * is the only way the statement fails — and the real role is shared with every
 * database on the machine.
 */
import { expect, it } from 'bun:test';
import { sql } from 'kysely';
import { _internalForTests, executeFlow } from '../../lib/flows/flow-executor.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

it.skipIf(!harnessAvailable())(
  'query_db still runs when the reader role does not exist',
  async () => {
    const { db } = await getTestApp();
    const flowId = crypto.randomUUID();
    await db
      .insertInto('zv_flows' as never)
      .values({
        id: flowId,
        name: 'absent reader role probe',
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

    const restore = _internalForTests.setFlowReaderRoleForTests('zveltio_absent_role_probe');
    try {
      const run = await executeFlow(db, flowId, { trigger: 'probe' });
      // Without the SAVEPOINT this is 'failed', with
      // `current transaction is aborted, commands ignored until end of
      // transaction block`.
      expect(run.error ?? '').not.toContain('transaction is aborted');
      expect(run.status).toBe('success');
    } finally {
      restore();
      await db.deleteFrom('zv_flows').where('id', '=', flowId).execute();
    }
  },
  30_000,
);
