/**
 * ADR 0058 decision 1 (DR-05): the flow `query_db` step is removed.
 *
 * It ran its author's SQL. RLS reads the `zveltio.*` settings, and that SQL
 * could rewrite them in its own transaction:
 *
 *   SELECT set_config('zveltio.current_tenant', '<other firm>', true),
 *          query_to_xml('select * from zvd_<collection>', true, false, '')
 *
 * returned the other firm's rows as `zveltio_flow_reader`, and without that
 * role the step ran as the connection role (a superuser on a stock install).
 *
 * Now: no route stores one (400 naming ADR 0058), the CHECK refuses one
 * (migration 124), and a step stored before 124 is kept but never runs — the
 * flow fails before its first step, whatever `on_error` says.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { executeFlow } from '../../lib/flows/index.js';
import {
  asDefaultTenant,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `qdb_${Date.now()}`;
const MARKER = `${STAMP}_ran`;

d('flow query_db is removed (ADR 0058)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  const createFlow = async (steps: unknown[]) =>
    app.request(
      '/api/flows',
      json('POST', {
        name: `${STAMP}-${Math.random()}`,
        trigger: { type: 'manual' },
        steps,
      }),
    );

  /** A `query_db` row as an install stored it before migration 124. */
  async function storeLegacyStep(flowId: string, onError: 'stop' | 'continue') {
    await db.transaction().execute(async (trx) => {
      const def = await sql<{ def: string }>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'zv_flow_steps_type_check'`.execute(trx);
      await sql`ALTER TABLE zv_flow_steps DROP CONSTRAINT zv_flow_steps_type_check`.execute(trx);
      await sql`
        INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config, on_error)
        VALUES (${flowId}, 0, 'legacy report', 'query_db',
                ${JSON.stringify({ query: `SELECT '${MARKER}' AS m` })}::jsonb, ${onError})
      `.execute(trx);
      await sql
        .raw(
          `ALTER TABLE zv_flow_steps ADD CONSTRAINT zv_flow_steps_type_check ${def.rows[0]!.def}`,
        )
        .execute(trx);
    });
  }

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    await asDefaultTenant(db, (trx) =>
      sql`DELETE FROM zv_flows WHERE name LIKE ${`${STAMP}%`}`.execute(trx),
    );
  });

  it('a flow with a query_db step is refused at create, naming the removal', async () => {
    const res = await createFlow([{ type: 'query_db', config: { query: 'SELECT 1' } }]);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('ADR 0058');
  });

  it('a query_db step is refused when added or when a step is changed into one', async () => {
    const made = await createFlow([{ type: 'condition', config: { expression: '1 < 2' } }]);
    expect(made.status).toBe(201);
    const { flow } = (await made.json()) as { flow: { id: string; steps: { id: string }[] } };

    const add = await app.request(
      `/api/flows/${flow.id}/steps`,
      json('POST', { type: 'query_db', config: { query: 'SELECT 1' } }),
    );
    expect(add.status).toBe(400);
    expect(await add.text()).toContain('ADR 0058');

    const retype = await app.request(
      `/api/flows/${flow.id}/steps/${flow.steps[0]!.id}`,
      json('PUT', { type: 'query_db', config: { query: 'SELECT 1' } }),
    );
    expect(retype.status).toBe(400);
    expect(await retype.text()).toContain('ADR 0058');
  });

  it('the CHECK refuses a new query_db row', async () => {
    const made = await createFlow([]);
    const { flow } = (await made.json()) as { flow: { id: string } };
    const err = await sql`
      INSERT INTO zv_flow_steps (flow_id, step_order, name, type, config)
      VALUES (${flow.id}, 0, 'x', 'query_db', '{}'::jsonb)`
      .execute(db)
      .then(() => null)
      .catch((e: { errno?: string }) => e);
    expect(err?.errno).toBe('23514');
  });

  it.each(['stop', 'continue'] as const)(
    'a stored query_db step (on_error %s) fails the run and its SQL never runs',
    async (onError) => {
      const made = await createFlow([]);
      const { flow } = (await made.json()) as { flow: { id: string } };
      await storeLegacyStep(flow.id, onError);

      const result = await executeFlow(db, flow.id, {});
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/"legacy report" is type query_db.*ADR 0058/);
      expect(JSON.stringify(result.output ?? null)).not.toContain(MARKER);

      const run = await sql<{ status: string; error: string }>`
        SELECT status, error FROM zv_flow_runs WHERE id = ${result.runId}`.execute(db);
      expect(run.rows[0]?.status).toBe('failed');
      expect(run.rows[0]?.error).toContain('ADR 0058');
      // Kept, not deleted: the author's SQL is theirs.
      const kept = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_flow_steps
         WHERE flow_id = ${flow.id} AND type = 'query_db'`.execute(db);
      expect(kept.rows[0]?.n).toBe(1);
    },
  );
});
