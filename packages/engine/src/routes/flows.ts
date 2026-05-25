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

// The wire format for steps in POST/PATCH bodies. Internally each step
// lives as a row in `zv_flow_steps` with a `step_order` column; the
// routes treat the request array as the canonical order.
const StepSchema = z.object({
  id:          z.string().uuid().optional(),
  type:        z.string().min(1),
  name:        z.string().optional(),
  config:      z.record(z.string(), z.unknown()).default({}),
  on_error:    z.enum(['stop', 'continue', 'retry']).default('stop'),
});

type StepInput = z.infer<typeof StepSchema>;

const TriggerSchema = z.object({
  type:       z.enum(['manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook']),
  collection: z.string().optional(),
  event:      z.enum(['insert', 'update', 'delete']).optional(),
  cron:       z.string().optional(),
});

type TriggerInput = z.infer<typeof TriggerSchema>;

// Reads a flow joined with its steps in step_order. Returns null if the
// flow doesn't exist.
async function loadFlowWithSteps(db: Database, flowId: string) {
  const flow = await db
    .selectFrom('zv_flows')
    .selectAll()
    .where('id', '=', flowId)
    .executeTakeFirst();
  if (!flow) return null;

  const steps = await db
    .selectFrom('zv_flow_steps')
    .selectAll()
    .where('flow_id', '=', flowId)
    .orderBy('step_order', 'asc')
    .execute();

  return { ...flow, steps };
}

// Replaces the steps for a flow in a single transaction (delete all,
// insert in order). Used by POST / and PATCH /:id when the caller sends
// a full steps array.
async function replaceSteps(db: Database, flowId: string, steps: StepInput[]): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('zv_flow_steps').where('flow_id', '=', flowId).execute();
    if (steps.length === 0) return;
    await trx
      .insertInto('zv_flow_steps')
      .values(
        steps.map((s, i) => ({
          flow_id:    flowId,
          step_order: i,
          name:       s.name ?? s.type,
          type:       s.type as any, // CHECK constraint validates at the DB layer
          config:     JSON.stringify(s.config),
          on_error:   s.on_error,
        })),
      )
      .execute();
  });
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

  // GET / — list flows (no steps, just the flow rows)
  app.get('/', async (c) => {
    const flows = await db
      .selectFrom('zv_flows')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .execute();
    return c.json({ flows });
  });

  // GET /:id — get a flow with its steps
  app.get('/:id', async (c) => {
    const flow = await loadFlowWithSteps(db, c.req.param('id'));
    if (!flow) return c.json({ error: 'Flow not found' }, 404);
    return c.json({ flow });
  });

  // POST / — create flow (+ its initial steps)
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name:        z.string().min(1),
        description: z.string().optional(),
        trigger:     TriggerSchema,
        steps:       z.array(StepSchema).default([]),
        is_active:   z.boolean().default(true),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const user = c.get('user') as { id: string };

      // Validate each step's config before persisting anything.
      for (const step of body.steps) {
        const v = validateStepConfig(step.type, step.config);
        if (!v.valid) {
          return c.json({ error: `Invalid config for step type ${step.type}`, errors: v.errors }, 400);
        }
      }

      const flow = await db
        .insertInto('zv_flows')
        .values({
          name:           body.name,
          description:    body.description ?? null,
          is_active:      body.is_active,
          trigger_type:   body.trigger.type,
          trigger_config: JSON.stringify(toTriggerConfig(body.trigger)),
          created_by:     user.id,
        })
        .returningAll()
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Failed to create flow' }, 500);

      if (body.steps.length > 0) {
        await replaceSteps(db, flow.id, body.steps);
      }

      const created = await loadFlowWithSteps(db, flow.id);
      return c.json({ flow: created }, 201);
    },
  );

  // PATCH /:id — update flow (optionally replaces steps in-place)
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name:        z.string().optional(),
        description: z.string().optional(),
        trigger:     TriggerSchema.optional(),
        steps:       z.array(StepSchema).optional(),
        is_active:   z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const flowId = c.req.param('id');

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined)        updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.is_active !== undefined)   updates.is_active = body.is_active;
      if (body.trigger !== undefined) {
        updates.trigger_type   = body.trigger.type;
        updates.trigger_config = JSON.stringify(toTriggerConfig(body.trigger));
      }

      // Validate any new step configs before touching the DB.
      if (body.steps) {
        for (const step of body.steps) {
          const v = validateStepConfig(step.type, step.config);
          if (!v.valid) {
            return c.json({ error: `Invalid config for step type ${step.type}`, errors: v.errors }, 400);
          }
        }
      }

      const flow = await db
        .updateTable('zv_flows')
        .set(updates)
        .where('id', '=', flowId)
        .returningAll()
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Flow not found' }, 404);

      if (body.steps !== undefined) {
        await replaceSteps(db, flowId, body.steps);
      }

      const updated = await loadFlowWithSteps(db, flowId);
      return c.json({ flow: updated });
    },
  );

  // DELETE /:id — delete a flow. Steps + runs cascade via FK.
  app.delete('/:id', async (c) => {
    await db.deleteFrom('zv_flows').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  // POST /:id/run — manual trigger
  app.post('/:id/run', async (c) => {
    const flow = await db
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
    const runs = await db
      .selectFrom('zv_flow_runs')
      .select(['id', 'status', 'error', 'started_at', 'finished_at'])
      .where('flow_id', '=', c.req.param('id'))
      .orderBy('started_at', 'desc')
      .limit(50)
      .execute();

    return c.json({ runs });
  });

  // GET /runs/:runId — run detail
  app.get('/runs/:runId', async (c) => {
    const run = await db
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
    let query = db
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
    const entry = await db
      .selectFrom('zv_flow_dlq')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!entry) return c.json({ error: 'DLQ entry not found' }, 404);

    const flow = await db
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

    await db.deleteFrom('zv_flow_dlq').where('id', '=', entry.id).execute();
    executeFlow(db, flow.id, payload.trigger_data ?? {}).catch(console.error);

    return c.json({ message: 'DLQ entry requeued', flow_id: entry.flow_id }, 202);
  });

  // POST /:id/steps — append a single validated step
  app.post(
    '/:id/steps',
    zValidator('json', StepSchema),
    async (c) => {
      const body = c.req.valid('json');
      const flowId = c.req.param('id');

      const validation = validateStepConfig(body.type, body.config);
      if (!validation.valid) {
        return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
      }

      const flow = await db
        .selectFrom('zv_flows')
        .select(['id'])
        .where('id', '=', flowId)
        .executeTakeFirst();
      if (!flow) return c.json({ error: 'Flow not found' }, 404);

      // Append at the end — fetch current max step_order first.
      const last = await db
        .selectFrom('zv_flow_steps')
        .select((eb) => eb.fn.max('step_order').as('max_order'))
        .where('flow_id', '=', flowId)
        .executeTakeFirst();
      const nextOrder = (last?.max_order ?? -1) + 1;

      const step = await db
        .insertInto('zv_flow_steps')
        .values({
          flow_id:    flowId,
          step_order: nextOrder as number,
          name:       body.name ?? body.type,
          type:       body.type as any,
          config:     JSON.stringify(validation.config ?? body.config),
          on_error:   body.on_error,
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ step }, 201);
    },
  );

  // PUT /:id/steps/:stepId — update a single step's name/type/config/on_error
  app.put(
    '/:id/steps/:stepId',
    zValidator('json', StepSchema.partial()),
    async (c) => {
      const body = c.req.valid('json');
      const flowId = c.req.param('id');
      const stepId = c.req.param('stepId');

      const existing = await db
        .selectFrom('zv_flow_steps')
        .selectAll()
        .where('id', '=', stepId)
        .where('flow_id', '=', flowId)
        .executeTakeFirst();
      if (!existing) return c.json({ error: 'Step not found' }, 404);

      const newType = body.type ?? existing.type;
      // body.config is the only validation-sensitive bit; if absent, keep the stored config.
      const newConfig = body.config ?? (existing.config as Record<string, unknown>);

      const validation = validateStepConfig(newType, newConfig);
      if (!validation.valid) {
        return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
      }

      const updates: Record<string, unknown> = {};
      if (body.type !== undefined)     updates.type = body.type as any;
      if (body.name !== undefined)     updates.name = body.name;
      if (body.on_error !== undefined) updates.on_error = body.on_error;
      if (body.config !== undefined)   updates.config = JSON.stringify(validation.config ?? body.config);

      const updated = await db
        .updateTable('zv_flow_steps')
        .set(updates)
        .where('id', '=', stepId)
        .returningAll()
        .executeTakeFirst();

      return c.json({ step: updated });
    },
  );

  // DELETE /:id/steps/:stepId — remove a single step. Re-compacts step_order
  // so the remaining steps stay 0..N-1 contiguous.
  app.delete('/:id/steps/:stepId', async (c) => {
    const flowId = c.req.param('id');
    const stepId = c.req.param('stepId');

    await db.transaction().execute(async (trx) => {
      const removed = await trx
        .deleteFrom('zv_flow_steps')
        .where('id', '=', stepId)
        .where('flow_id', '=', flowId)
        .returningAll()
        .executeTakeFirst();
      if (!removed) return;

      // Re-compact ordering of subsequent steps in the same flow.
      const remaining = await trx
        .selectFrom('zv_flow_steps')
        .select(['id', 'step_order'])
        .where('flow_id', '=', flowId)
        .where('step_order', '>', removed.step_order)
        .orderBy('step_order', 'asc')
        .execute();

      for (const r of remaining) {
        await trx
          .updateTable('zv_flow_steps')
          .set({ step_order: r.step_order - 1 })
          .where('id', '=', r.id)
          .execute();
      }
    });

    const remaining = await db
      .selectFrom('zv_flow_steps')
      .select((eb) => eb.fn.count('id').as('count'))
      .where('flow_id', '=', flowId)
      .executeTakeFirst();

    return c.json({ success: true, total_steps: Number(remaining?.count ?? 0) });
  });

  return app;
}

/**
 * Builds the trigger_config JSONB blob from the parsed trigger input.
 * trigger_type is stored in its own column; everything else (collection,
 * event, cron expression) becomes the config payload that the flow
 * executor consumes.
 */
function toTriggerConfig(trigger: TriggerInput): Record<string, unknown> {
  const { type: _type, ...rest } = trigger;
  return rest;
}

/**
 * Trigger data-event flows when a record is created/updated/deleted.
 * Called from the data route after each write operation.
 *
 * Reads each candidate flow's trigger_config to decide which to execute.
 */
export async function triggerDataFlows(
  db: Database,
  collection: string,
  event: 'insert' | 'update' | 'delete',
  record: any,
): Promise<void> {
  try {
    // Map the data-route event vocabulary onto the trigger_type CHECK
    // constraint values stored in zv_flows.
    const triggerType =
      event === 'insert' ? 'on_create' :
      event === 'update' ? 'on_update' :
                           'on_delete';

    const flows = await db
      .selectFrom('zv_flows')
      .selectAll()
      .where('is_active', '=', true)
      .where('trigger_type', '=', triggerType)
      .execute()
      .catch(() => []);

    for (const flow of flows) {
      const cfg = (typeof flow.trigger_config === 'string'
        ? JSON.parse(flow.trigger_config)
        : (flow.trigger_config ?? {})) as { collection?: string };
      if (cfg.collection === collection) {
        executeFlow(db, flow.id, { collection, event, record }).catch(console.error);
      }
    }
  } catch {
    // Flow triggering must not break data operations
  }
}
