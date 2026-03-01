// packages/engine/src/routes/flows.ts
import { Hono } from 'hono';
import { sql } from 'kysely';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { runScript } from '../lib/script-runner.js';
import { flowScheduler } from '../lib/flow-scheduler.js';
import { executeFlow } from '../lib/flow-executor.js';
import type { Database } from '../db/index.js';

export function flowsRoutes(db: Database, _auth: any): Hono {
  const router = new Hono();

  // Auth + admin guard
  router.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin required' }, 403);
    c.set('user' as any, session.user);
    await next();
  });

  // GET /api/flows
  router.get('/', async (c) => {
    const result = await sql<any>`
      SELECT f.*,
             u.name AS creator_name,
             COUNT(r.id) AS total_runs,
             MAX(r.started_at) AS last_run_at
      FROM zv_flows f
      LEFT JOIN "user" u ON u.id = f.created_by
      LEFT JOIN zv_flow_runs r ON r.flow_id = f.id
      GROUP BY f.id, u.name
      ORDER BY f.created_at DESC
    `.execute(db);
    return c.json({ flows: result.rows });
  });

  // GET /api/flows/scheduler/status
  router.get('/scheduler/status', async (c) => {
    return c.json(flowScheduler.getStatus());
  });

  // POST /api/flows/run-script — run arbitrary script without a flow
  router.post('/run-script', async (c) => {
    const { code, input, timeout_ms } = await c.req.json();
    if (!code) return c.json({ error: 'code is required' }, 400);
    const result = await runScript(code, input || {}, timeout_ms || 10000);
    return c.json(result);
  });

  // GET /api/flows/:id
  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const flow = await sql<any>`SELECT * FROM zv_flows WHERE id = ${id}`.execute(db);
    if (flow.rows.length === 0) return c.json({ error: 'Not found' }, 404);

    const steps = await sql<any>`
      SELECT * FROM zv_flow_steps WHERE flow_id = ${id} ORDER BY step_order
    `.execute(db);

    return c.json({ flow: flow.rows[0], steps: steps.rows });
  });

  // POST /api/flows
  router.post('/', async (c) => {
    const user = (c as any).get('user');
    const data = await c.req.json();
    const row = await (db as any)
      .insertInto('zv_flows')
      .values({
        name: data.name,
        description: data.description || null,
        trigger_type: data.trigger_type || 'manual',
        trigger_config: JSON.stringify(data.trigger_config || {}),
        is_active: data.is_active ?? true,
        created_by: user.id,
      })
      .returningAll()
      .executeTakeFirst();
    return c.json({ flow: row }, 201);
  });

  // PUT /api/flows/:id — full replace
  router.put('/:id', async (c) => {
    const id = c.req.param('id');
    const data = await c.req.json();
    const allowed = ['name', 'description', 'is_active', 'trigger_type', 'trigger_config'];
    const updateData: Record<string, any> = { updated_at: new Date() };
    for (const key of allowed) {
      if (data[key] !== undefined) updateData[key] = data[key];
    }
    await (db as any).updateTable('zv_flows').set(updateData).where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // PATCH /api/flows/:id — partial update, returns updated flow
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const data = await c.req.json();
    const allowed = ['name', 'description', 'is_active', 'trigger_type', 'trigger_config'];
    const updateData: Record<string, any> = { updated_at: new Date() };
    for (const key of allowed) {
      if (data[key] !== undefined) updateData[key] = data[key];
    }
    const updated = await (db as any)
      .updateTable('zv_flows')
      .set(updateData)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json({ flow: updated });
  });

  // DELETE /api/flows/:id
  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    await (db as any).deleteFrom('zv_flows').where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // POST /api/flows/:id/steps
  router.post('/:id/steps', async (c) => {
    const flowId = c.req.param('id');
    const data = await c.req.json();
    const result = await sql<{ id: string }>`
      INSERT INTO zv_flow_steps (flow_id, name, type, config, step_order, on_error)
      VALUES (
        ${flowId}, ${data.name}, ${data.type},
        ${JSON.stringify(data.config || {})},
        ${data.step_order ?? 0},
        ${data.on_error || 'stop'}
      )
      RETURNING id
    `.execute(db);
    return c.json({ id: result.rows[0].id }, 201);
  });

  // DELETE /api/flows/:id/steps/:stepId
  router.delete('/:id/steps/:stepId', async (c) => {
    const stepId = c.req.param('stepId');
    await (db as any).deleteFrom('zv_flow_steps').where('id', '=', stepId).execute();
    return c.json({ success: true });
  });

  // POST /api/flows/:id/run — manual trigger
  router.post('/:id/run', async (c) => {
    const id = c.req.param('id');
    const triggerData = await c.req.json().catch(() => ({}));

    const result = await executeFlow(db, id, { ...triggerData, trigger: 'manual' });

    if (result.status === 'failed') {
      return c.json({ run_id: result.runId, status: 'failed', error: result.error }, 500);
    }
    return c.json({ run_id: result.runId, status: result.status, output: result.output });
  });

  // GET /api/flows/:id/runs
  router.get('/:id/runs', async (c) => {
    const id = c.req.param('id');
    const result = await sql<any>`
      SELECT * FROM zv_flow_runs
      WHERE flow_id = ${id}
      ORDER BY started_at DESC
      LIMIT 50
    `.execute(db);
    return c.json({ runs: result.rows });
  });

  return router;
}
