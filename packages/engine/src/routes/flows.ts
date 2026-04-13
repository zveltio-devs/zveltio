import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { executeFlow } from '../lib/flow-executor.js';
import { validateStepConfig } from '../lib/flow-step-schemas.js';
import { checkPermission } from '../lib/permissions.js';

async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await checkPermission(session.user.id, 'admin', '*'))) return null;
  return session.user;
}

export function flowsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Admin auth middleware — flows are admin-only resources
  app.use('*', async (c, next) => {
    const user = await requireAdmin(c, auth);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', user);
    await next();
  });

  // GET / — list flows
  app.get('/', async (c) => {

    const flows = await (db as any)
      .selectFrom('zv_flows')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute();

    return c.json({ flows });
  });

  // GET /:id — get flow
  app.get('/:id', async (c) => {
    const flow = await (db as any)
      .selectFrom('zv_flows')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);
    return c.json({ flow });
  });

  // POST / — create flow
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        trigger: z.object({
          type: z.enum(['data_event', 'webhook', 'cron', 'manual']),
          collection: z.string().optional(),
          event: z.enum(['insert', 'update', 'delete']).optional(),
          cron: z.string().optional(),
        }),
        steps: z.array(z.any()).default([]),
        is_active: z.boolean().default(true),
      }),
    ),
    async (c) => {
        const body = c.req.valid('json');
      const flow = await (db as any)
        .insertInto('zv_flows')
        .values({
          name: body.name,
          description: body.description,
          is_active: body.is_active,
          trigger: JSON.stringify(body.trigger),
          steps: JSON.stringify(body.steps),
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ flow }, 201);
    },
  );

  // PATCH /:id — update flow
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        trigger: z.any().optional(),
        steps: z.array(z.any()).optional(),
        is_active: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const updates: any = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.trigger !== undefined) updates.trigger = JSON.stringify(body.trigger);
      if (body.steps !== undefined) updates.steps = JSON.stringify(body.steps);
      if (body.is_active !== undefined) updates.is_active = body.is_active;

      const flow = await (db as any)
        .updateTable('zv_flows')
        .set(updates)
        .where('id', '=', c.req.param('id'))
        .returningAll()
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Flow not found' }, 404);
      return c.json({ flow });
    },
  );

  // DELETE /:id
  app.delete('/:id', async (c) => {
    await (db as any).deleteFrom('zv_flows').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // POST /:id/run — manual trigger
  app.post('/:id/run', async (c) => {
    const flow = await (db as any)
      .selectFrom('zv_flows')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    executeFlow(db, flow.id, { trigger: 'manual', ...body }).catch(console.error);

    return c.json({ message: 'Flow triggered', flow_id: flow.id }, 202);
  });

  // GET /:id/runs — run history
  app.get('/:id/runs', async (c) => {
    const runs = await (db as any)
      .selectFrom('zv_flow_runs')
      .select(['id', 'status', 'error', 'started_at', 'completed_at', 'created_at'])
      .where('flow_id', '=', c.req.param('id'))
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();

    return c.json({ runs });
  });

  // GET /runs/:runId — run detail
  app.get('/runs/:runId', async (c) => {
    const run = await (db as any)
      .selectFrom('zv_flow_runs')
      .selectAll()
      .where('id', '=', c.req.param('runId'))
      .executeTakeFirst();

    if (!run) return c.json({ error: 'Run not found' }, 404);
    return c.json({ run });
  });

  // GET /dlq — dead letter queue
  app.get('/dlq', async (c) => {
    const flowId = c.req.query('flow_id');
    let query = (db as any)
      .selectFrom('zv_flow_dlq')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(100);

    if (flowId) query = query.where('flow_id', '=', flowId);

    const entries = await query.execute();
    return c.json({ entries });
  });

  // POST /dlq/:id/retry — requeue a DLQ entry
  app.post('/dlq/:id/retry', async (c) => {
    const entry = await (db as any)
      .selectFrom('zv_flow_dlq')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!entry) return c.json({ error: 'DLQ entry not found' }, 404);

    const flow = await (db as any)
      .selectFrom('zv_flows')
      .selectAll()
      .where('id', '=', entry.flow_id)
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);

    let payload: any;
    try {
      payload = typeof entry.payload === 'string' ? JSON.parse(entry.payload) : (entry.payload ?? {});
    } catch {
      payload = {};
    }

    await (db as any).deleteFrom('zv_flow_dlq').where('id', '=', entry.id).execute();
    executeFlow(db, flow.id, payload.trigger_data ?? {}).catch(console.error);

    return c.json({ message: 'DLQ entry requeued', flow_id: entry.flow_id }, 202);
  });

  // POST /:id/steps — add a validated step to an existing flow
  app.post(
    '/:id/steps',
    zValidator(
      'json',
      z.object({
        type:        z.string().min(1),
        name:        z.string().optional(),
        description: z.string().optional(),
        config:      z.record(z.string(), z.unknown()).default({}),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');

      // Validate step config before persisting
      const validation = validateStepConfig(body.type, body.config);
      if (!validation.valid) {
        return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
      }

      const flow = await (db as any)
        .selectFrom('zv_flows')
        .select(['id', 'steps'])
        .where('id', '=', c.req.param('id'))
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Flow not found' }, 404);

      const existingSteps: any[] = typeof flow.steps === 'string'
        ? JSON.parse(flow.steps)
        : (flow.steps ?? []);

      const newStep = {
        id:          crypto.randomUUID(),
        type:        body.type,
        name:        body.name ?? body.type,
        description: body.description,
        config:      validation.config,
      };

      const updatedSteps = [...existingSteps, newStep];

      await (db as any)
        .updateTable('zv_flows')
        .set({ steps: JSON.stringify(updatedSteps), updated_at: new Date() })
        .where('id', '=', c.req.param('id'))
        .execute();

      return c.json({ step: newStep, total_steps: updatedSteps.length }, 201);
    },
  );

  // PUT /:id/steps/:stepId — update a step's config with validation
  app.put(
    '/:id/steps/:stepId',
    zValidator(
      'json',
      z.object({
        type:        z.string().optional(),
        name:        z.string().optional(),
        description: z.string().optional(),
        config:      z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');

      const flow = await (db as any)
        .selectFrom('zv_flows')
        .select(['id', 'steps'])
        .where('id', '=', c.req.param('id'))
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Flow not found' }, 404);

      const steps: any[] = typeof flow.steps === 'string'
        ? JSON.parse(flow.steps)
        : (flow.steps ?? []);

      const stepIndex = steps.findIndex((s) => s.id === c.req.param('stepId'));
      if (stepIndex === -1) return c.json({ error: 'Step not found' }, 404);

      const existing = steps[stepIndex];
      const newType   = body.type ?? existing.type;
      const newConfig = body.config ?? existing.config;

      // Validate updated config
      const validation = validateStepConfig(newType, newConfig);
      if (!validation.valid) {
        return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
      }

      steps[stepIndex] = {
        ...existing,
        type:        newType,
        name:        body.name ?? existing.name,
        description: body.description ?? existing.description,
        config:      validation.config,
      };

      await (db as any)
        .updateTable('zv_flows')
        .set({ steps: JSON.stringify(steps), updated_at: new Date() })
        .where('id', '=', c.req.param('id'))
        .execute();

      return c.json({ step: steps[stepIndex] });
    },
  );

  // DELETE /:id/steps/:stepId — remove a step
  app.delete('/:id/steps/:stepId', async (c) => {
    const flow = await (db as any)
      .selectFrom('zv_flows')
      .select(['id', 'steps'])
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);

    const steps: any[] = typeof flow.steps === 'string'
      ? JSON.parse(flow.steps)
      : (flow.steps ?? []);

    const filtered = steps.filter((s) => s.id !== c.req.param('stepId'));
    if (filtered.length === steps.length) return c.json({ error: 'Step not found' }, 404);

    await (db as any)
      .updateTable('zv_flows')
      .set({ steps: JSON.stringify(filtered), updated_at: new Date() })
      .where('id', '=', c.req.param('id'))
      .execute();

    return c.json({ success: true, total_steps: filtered.length });
  });

  return app;
}

/**
 * Trigger data_event flows when a record is created/updated/deleted.
 * Called from the data route after each write operation.
 */
export async function triggerDataFlows(
  db: Database,
  collection: string,
  event: 'insert' | 'update' | 'delete',
  record: any,
): Promise<void> {
  try {
    const flows: any[] = await (db as any)
      .selectFrom('zv_flows')
      .selectAll()
      .where('is_active', '=', true)
      .execute()
      .catch(() => []);

    for (const flow of flows) {
      const trigger = typeof flow.trigger === 'string' ? JSON.parse(flow.trigger) : flow.trigger;
      if (
        trigger.type === 'data_event' &&
        trigger.collection === collection &&
        (trigger.event === event || trigger.event === '*')
      ) {
        executeFlow(db, flow.id, { collection, event, record }).catch(console.error);
      }
    }
  } catch {
    // Flow triggering must not break data operations
  }
}
