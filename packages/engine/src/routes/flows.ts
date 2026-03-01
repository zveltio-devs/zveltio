// packages/engine/src/routes/flows.ts
import { Hono } from 'hono';
import { sql } from 'kysely';
import { auth } from '../lib/auth.js';
import { checkPermission } from '../lib/permissions.js';
import { runScript } from '../lib/script-runner.js';
import { flowScheduler } from '../lib/flow-scheduler.js';
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

    const runResult = await sql<{ id: string }>`
      INSERT INTO zv_flow_runs (flow_id, status, trigger_data)
      VALUES (${id}, 'running', ${JSON.stringify(triggerData)})
      RETURNING id
    `.execute(db);
    const runId = runResult.rows[0].id;

    try {
      const steps = await sql<any>`
        SELECT * FROM zv_flow_steps WHERE flow_id = ${id} ORDER BY step_order
      `.execute(db);

      let output: any = {};

      for (const step of steps.rows) {
        if (step.type === 'query_db' && step.config?.query) {
          const result = await sql.raw(step.config.query).execute(db);
          output = result.rows;

        } else if (step.type === 'run_script' && step.config?.code) {
          const scriptResult = await runScript(
            step.config.code,
            step.config.input || output,
            step.config.timeout_ms || 30000,
          );
          if (scriptResult.error) {
            throw new Error(`Script error in step "${step.name}": ${scriptResult.error}`);
          }
          output = scriptResult.output;

        } else if (step.type === 'send_email' && step.config?.to) {
          try {
            const { sendEmailDirectly } = await import('../lib/email.js');
            await sendEmailDirectly({
              recipient: step.config.to,
              subject: step.config.subject || 'Flow notification',
              bodyHtml: step.config.body_html || step.config.body || '',
              bodyText: step.config.body || '',
            });
            output = { sent: true, to: step.config.to };
          } catch {
            output = { sent: false, error: 'Email service not configured' };
          }

        } else if (step.type === 'webhook' && step.config?.url) {
          const response = await fetch(step.config.url, {
            method: step.config.method || 'POST',
            headers: { 'Content-Type': 'application/json', ...(step.config.headers || {}) },
            body: JSON.stringify(step.config.body || output),
          });
          output = { status: response.status, ok: response.ok };

        } else if (step.type === 'send_notification') {
          try {
            const { createNotification, notifyRole } = await import('../lib/notifications.js');
            if (step.config.role) {
              await notifyRole(step.config.role, {
                title: step.config.title,
                message: step.config.message,
                type: step.config.type || 'info',
                source: 'flow',
                action_url: step.config.action_url,
              });
              output = { sent: true, sent_to: 'role', role: step.config.role };
            } else if (step.config.user_id) {
              const notifId = await createNotification({
                user_id: step.config.user_id,
                title: step.config.title,
                message: step.config.message,
                type: step.config.type || 'info',
                source: 'flow',
                action_url: step.config.action_url,
              });
              output = { sent: true, id: notifId, sent_to: 'user', user_id: step.config.user_id };
            } else {
              output = { sent: false, error: 'No role or user_id specified' };
            }
          } catch {
            output = { sent: false, error: 'Notifications service not configured' };
          }

        } else if (step.type === 'export_collection' && step.config?.collection) {
          try {
            const { ExportManager } = await import('../lib/export-manager.js');
            const tableName = step.config.collection.startsWith('zvd_')
              ? step.config.collection
              : `zvd_${step.config.collection}`;
            const rows = await sql<any>`
              SELECT * FROM ${sql.raw(tableName)}
              LIMIT ${step.config.limit || 1000}
            `.execute(db);
            const exportResult = await ExportManager.export(rows.rows, {
              format: step.config.format || 'csv',
              filename: step.config.filename || `${step.config.collection}-export`,
              columns: step.config.columns,
            });
            if (step.config.email_to && exportResult?.buffer) {
              const { sendEmailWithAttachment } = await import('../lib/email.js');
              const ext = step.config.format === 'excel' ? 'xlsx' : (step.config.format || 'csv');
              await sendEmailWithAttachment({
                recipient: step.config.email_to,
                subject: step.config.email_subject || `Report: ${step.config.collection}`,
                bodyHtml: step.config.email_body || '<p>Please find the attached report.</p>',
                bodyText: step.config.email_body || 'Please find the attached report.',
                attachment: {
                  filename: `${step.config.filename || step.config.collection}.${ext}`,
                  content: exportResult.buffer,
                  contentType: step.config.format === 'excel'
                    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                    : 'text/csv',
                },
              });
              output = { exported: true, sent_to: step.config.email_to, rows: rows.rows.length };
            } else {
              output = { exported: true, rows: rows.rows.length };
            }
          } catch {
            output = { exported: false, error: 'Export service not configured' };
          }
        }
      }

      await sql`
        UPDATE zv_flow_runs
        SET status = 'success', output = ${JSON.stringify(output)}, finished_at = NOW()
        WHERE id = ${runId}
      `.execute(db);

      return c.json({ run_id: runId, status: 'success', output });
    } catch (error) {
      await sql`
        UPDATE zv_flow_runs
        SET status = 'failed', error = ${String(error)}, finished_at = NOW()
        WHERE id = ${runId}
      `.execute(db);
      return c.json({ error: String(error) }, 500);
    }
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
