import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { auditLog } from '../lib/audit.js';
import { EXECUTABLE_STEP_TYPES, executeFlow } from '../lib/flows/index.js';
import { validateStepConfig } from '../lib/flows/index.js';
import { isTenantAdmin, requireInstanceAdmin } from '../lib/tenancy/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// zv_flows has no RLS and these routes run on the raw pool `db`, so every query is
// scoped to the request's tenant explicitly — otherwise one tenant's admin could
// read/patch/delete/run another tenant's flows by id, or enumerate the whole flow
// list (cross-tenant IDOR). "always-one-tenant", so this resolves to the default
// tenant in single-tenant installs. Child rows (steps/runs/dlq) are always reached
// through a flow, so scoping the flow (or joining the child reads to zv_flows)
// transitively protects them.
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';
const tenantOf = (c: Context): string =>
  (c.get('tenant') as { id?: string } | null)?.id ?? DEFAULT_TENANT;

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
async function requireAdmin(c: any, auth: any): Promise<any | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  if (!(await isTenantAdmin(session.user.id))) return null;
  return session.user;
}

// The wire format for steps in POST/PATCH bodies. Internally each step
// lives as a row in `zv_flow_steps` with a `step_order` column; the
// routes treat the request array as the canonical order.
const StepSchema = z.object({
  id: z.string().uuid().optional(),
  // Was `z.string().min(1)`, so any string was storable and the mistake only
  // surfaced at run time — where the executor's `default` arm reported success.
  // Anchored to what the executor implements, not to flow-step-schemas.ts,
  // which lists twelve types of which eight never run.
  //
  // This makes the Studio's `condition` / `create_record` / `update_record`
  // options fail at save with a message naming the supported types. That is a
  // visible regression against an invisible one: those steps never did anything,
  // and a builder who picks one now learns it while they can still change it.
  type: z.enum(EXECUTABLE_STEP_TYPES),
  name: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  on_error: z.enum(['stop', 'continue', 'retry']).default('stop'),
});

type StepInput = z.infer<typeof StepSchema>;

const TriggerSchema = z.object({
  type: z.enum(['manual', 'on_create', 'on_update', 'on_delete', 'cron', 'webhook']),
  collection: z.string().optional(),
  event: z.enum(['insert', 'update', 'delete']).optional(),
  cron: z.string().optional(),
});

type TriggerInput = z.infer<typeof TriggerSchema>;

// Reads a flow joined with its steps in step_order. Returns null if the
// flow doesn't exist for the given tenant. Steps are keyed by flow_id, so
// scoping the flow lookup transitively scopes the steps.
async function loadFlowWithSteps(db: Database, flowId: string, tenantId: string) {
  const flow = await db
    .selectFrom('zv_flows')
    .selectAll()
    .where('id', '=', flowId)
    .where('tenant_id', '=', tenantId)
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
          flow_id: flowId,
          step_order: i,
          name: s.name ?? s.type,
          // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
          type: s.type as any, // CHECK constraint validates at the DB layer
          config: JSON.stringify(s.config),
          on_error: s.on_error,
        })),
      )
      .execute();
  });
}

/**
 * Step types that hand the author raw execution against the engine's own
 * database or runtime. These are INSTANCE-admin only.
 *
 * `query_db` runs arbitrary SQL. It is read-only (SET TRANSACTION READ ONLY,
 * enforced by Postgres) and tenant-scoped for collection data — but the tenant
 * GUC only governs `zvd_*` rows. Better-Auth's `session` table has no RLS, so a
 * TENANT admin could author `SELECT token FROM "session"` and read every live
 * session on the instance, including god sessions. Read-only does not help: the
 * attack is a read.
 *
 * `run_script` is the same argument one level up.
 *
 * The durable fix is a dedicated Postgres role with no SELECT on the auth
 * tables, so the database enforces this the way it enforces read-only. Until
 * that exists, authorship is the boundary: a tenant admin cannot write these
 * steps, so cannot reach the tables.
 */
const INSTANCE_ADMIN_STEP_TYPES = new Set(['query_db', 'run_script']);

/**
 * Reject a flow body whose steps reach past the tenant boundary unless the
 * caller is an instance admin.
 *
 * Checked at CREATE and UPDATE rather than only at run: execution is also
 * reached by schedules and record hooks, which carry no caller, so the moment
 * to decide is when the step is written.
 */
async function assertStepTypesAllowed(
  userId: string,
  steps: Array<{ type: string }> | undefined,
): Promise<string | null> {
  const dangerous = (steps ?? [])
    .map((s) => s.type)
    .filter((t) => INSTANCE_ADMIN_STEP_TYPES.has(t));
  if (dangerous.length === 0) return null;
  if (await requireInstanceAdmin(userId)) return null;
  return (
    `Step type(s) ${[...new Set(dangerous)].join(', ')} require instance-admin rights: ` +
    `they execute raw SQL or code against the engine's database, which is not ` +
    `confined to your tenant.`
  );
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
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
      .where('tenant_id', '=', tenantOf(c))
      .orderBy('updated_at', 'desc')
      .execute();
    return c.json({ flows });
  });

  // GET /dlq — dead letter queue. MUST be registered before /:id, otherwise
  // the param route swallows `/dlq` (id="dlq") and the UUID cast on
  // zv_flows.id throws "invalid input syntax for type uuid" → 500.
  app.get('/dlq', async (c) => {
    const flowId = c.req.query('flow_id');
    // DLQ entries have no tenant_id of their own; scope by joining to the owning
    // flow so one tenant can't read another tenant's failed-flow payloads.
    let query = db
      .selectFrom('zv_flow_dlq as dlq')
      .innerJoin('zv_flows as f', 'f.id', 'dlq.flow_id')
      .selectAll('dlq')
      .where('f.tenant_id', '=', tenantOf(c))
      .orderBy('dlq.created_at', 'desc')
      .limit(100);

    if (flowId) query = query.where('dlq.flow_id', '=', flowId);

    const entries = await query.execute();
    return c.json({ entries });
  });

  // GET /runs/:runId — run detail. Also a static-prefix route, kept above
  // /:id for the same reason.
  app.get('/runs/:runId', async (c) => {
    const run = await db
      .selectFrom('zv_flow_runs as r')
      .innerJoin('zv_flows as f', 'f.id', 'r.flow_id')
      .selectAll('r')
      .where('r.id', '=', c.req.param('runId'))
      .where('f.tenant_id', '=', tenantOf(c))
      .executeTakeFirst();

    if (!run) return c.json({ error: 'Run not found' }, 404);
    return c.json({ run });
  });

  // GET /:id — get a flow with its steps
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    // Guard: zv_flows.id is UUID. A non-UUID param (e.g. a stray static
    // path that fell through) would make Postgres throw on the cast and
    // surface as a 500. Treat it as not-found instead.
    if (!UUID_RE.test(id)) return c.json({ error: 'Flow not found' }, 404);
    const flow = await loadFlowWithSteps(db, id, tenantOf(c));
    if (!flow) return c.json({ error: 'Flow not found' }, 404);
    return c.json({ flow });
  });

  // POST / — create flow (+ its initial steps)
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        trigger: TriggerSchema,
        steps: z.array(StepSchema).default([]),
        is_active: z.boolean().default(true),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const user = c.get('user') as { id: string };

      const stepDenial = await assertStepTypesAllowed(user.id, body.steps);
      if (stepDenial) return c.json({ error: stepDenial }, 403);

      // Validate each step's config before persisting anything.
      for (const step of body.steps) {
        const v = validateStepConfig(step.type, step.config);
        if (!v.valid) {
          return c.json(
            { error: `Invalid config for step type ${step.type}`, errors: v.errors },
            400,
          );
        }
      }

      const flow = await db
        .insertInto('zv_flows')
        .values({
          tenant_id: tenantOf(c),
          name: body.name,
          description: body.description ?? null,
          is_active: body.is_active,
          trigger_type: body.trigger.type,
          trigger_config: JSON.stringify(toTriggerConfig(body.trigger)),
          created_by: user.id,
        })
        .returningAll()
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Failed to create flow' }, 500);

      if (body.steps.length > 0) {
        await replaceSteps(db, flow.id, body.steps);
      }

      await auditLog(db, {
        type: 'settings.changed',
        userId: user.id,
        resourceId: flow.id,
        resourceType: 'flow',
        metadata: {
          action: 'create',
          name: body.name,
          trigger_type: body.trigger.type,
          step_count: body.steps.length,
        },
      });

      const created = await loadFlowWithSteps(db, flow.id, tenantOf(c));
      return c.json({ flow: created }, 201);
    },
  );

  // PATCH /:id — update flow (optionally replaces steps in-place)
  app.patch(
    '/:id',
    zValidator(
      'json',
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        trigger: TriggerSchema.optional(),
        steps: z.array(StepSchema).optional(),
        is_active: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const body = c.req.valid('json');
      const flowId = c.req.param('id');
      const patchUser = c.get('user') as { id: string };

      const stepDenial = await assertStepTypesAllowed(patchUser.id, body.steps);
      if (stepDenial) return c.json({ error: stepDenial }, 403);

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.is_active !== undefined) updates.is_active = body.is_active;
      if (body.trigger !== undefined) {
        updates.trigger_type = body.trigger.type;
        updates.trigger_config = JSON.stringify(toTriggerConfig(body.trigger));
      }

      // Validate any new step configs before touching the DB.
      if (body.steps) {
        for (const step of body.steps) {
          const v = validateStepConfig(step.type, step.config);
          if (!v.valid) {
            return c.json(
              { error: `Invalid config for step type ${step.type}`, errors: v.errors },
              400,
            );
          }
        }
      }

      const flow = await db
        .updateTable('zv_flows')
        .set(updates)
        .where('id', '=', flowId)
        .where('tenant_id', '=', tenantOf(c))
        .returningAll()
        .executeTakeFirst();

      if (!flow) return c.json({ error: 'Flow not found' }, 404);

      if (body.steps !== undefined) {
        await replaceSteps(db, flowId, body.steps);
      }

      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
      const user = c.get('user') as any;
      await auditLog(db, {
        type: 'settings.changed',
        userId: user?.id,
        resourceId: flowId,
        resourceType: 'flow',
        metadata: {
          action: 'update',
          changes: Object.keys(updates).filter((k) => k !== 'updated_at'),
          steps_replaced: body.steps !== undefined,
        },
      });

      const updated = await loadFlowWithSteps(db, flowId, tenantOf(c));
      return c.json({ flow: updated });
    },
  );

  // DELETE /:id — delete a flow. Steps + runs cascade via FK.
  app.delete('/:id', async (c) => {
    const flowId = c.req.param('id');
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user') as any;
    const deleted = await db
      .deleteFrom('zv_flows')
      .where('id', '=', flowId)
      .where('tenant_id', '=', tenantOf(c))
      .returning('id')
      .executeTakeFirst();
    if (!deleted) return c.json({ error: 'Flow not found' }, 404);
    await auditLog(db, {
      type: 'settings.changed',
      userId: user?.id,
      resourceId: flowId,
      resourceType: 'flow',
      metadata: { action: 'delete' },
    });
    return c.json({ success: true });
  });

  // POST /:id/run — manual trigger
  app.post('/:id/run', async (c) => {
    const flow = await db
      .selectFrom('zv_flows')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .where('tenant_id', '=', tenantOf(c))
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    executeFlow(db, flow.id, { trigger: 'manual', ...body }).catch(console.error);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    const user = c.get('user') as any;
    await auditLog(db, {
      type: 'settings.changed',
      userId: user?.id,
      resourceId: flow.id,
      resourceType: 'flow',
      metadata: { action: 'manual_trigger', name: flow.name },
    });

    return c.json({ message: 'Flow triggered', flow_id: flow.id }, 202);
  });

  // GET /:id/runs — run history
  app.get('/:id/runs', async (c) => {
    const runs = await db
      .selectFrom('zv_flow_runs as r')
      .innerJoin('zv_flows as f', 'f.id', 'r.flow_id')
      .select(['r.id', 'r.status', 'r.error', 'r.started_at', 'r.finished_at'])
      .where('r.flow_id', '=', c.req.param('id'))
      .where('f.tenant_id', '=', tenantOf(c))
      .orderBy('r.started_at', 'desc')
      .limit(50)
      .execute();

    return c.json({ runs });
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
      .where('tenant_id', '=', tenantOf(c))
      .executeTakeFirst();

    if (!flow) return c.json({ error: 'Flow not found' }, 404);

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    let payload: any;
    try {
      payload =
        typeof entry.payload === 'string' ? JSON.parse(entry.payload) : (entry.payload ?? {});
    } catch {
      payload = {};
    }

    await db.deleteFrom('zv_flow_dlq').where('id', '=', entry.id).execute();
    executeFlow(db, flow.id, payload.trigger_data ?? {}).catch(console.error);

    return c.json({ message: 'DLQ entry requeued', flow_id: entry.flow_id }, 202);
  });

  // POST /:id/steps — append a single validated step
  app.post('/:id/steps', zValidator('json', StepSchema), async (c) => {
    const body = c.req.valid('json');
    const flowId = c.req.param('id');
    const user = c.get('user') as { id: string };

    // Same gate as POST / and PATCH /:id. It was on the routes that write a
    // whole flow and missing from the two that write ONE step, so a tenant
    // admin who could not create a flow containing a `query_db` step could add
    // exactly that step to a flow they already owned — and `query_db` runs raw
    // SQL on the engine's database, which is not confined to their tenant.
    const stepDenial = await assertStepTypesAllowed(user.id, [body]);
    if (stepDenial) return c.json({ error: stepDenial }, 403);

    const validation = validateStepConfig(body.type, body.config);
    if (!validation.valid) {
      return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
    }

    const flow = await db
      .selectFrom('zv_flows')
      .select(['id'])
      .where('id', '=', flowId)
      .where('tenant_id', '=', tenantOf(c))
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
        flow_id: flowId,
        step_order: nextOrder as number,
        name: body.name ?? body.type,
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
        type: body.type as any,
        config: JSON.stringify(validation.config ?? body.config),
        on_error: body.on_error,
      })
      .returningAll()
      .executeTakeFirst();

    return c.json({ step }, 201);
  });

  // PUT /:id/steps/:stepId — update a single step's name/type/config/on_error
  app.put('/:id/steps/:stepId', zValidator('json', StepSchema.partial()), async (c) => {
    const body = c.req.valid('json');
    const flowId = c.req.param('id');
    const stepId = c.req.param('stepId');

    // Confirm the flow belongs to this tenant before touching its steps.
    const owner = await db
      .selectFrom('zv_flows')
      .select(['id'])
      .where('id', '=', flowId)
      .where('tenant_id', '=', tenantOf(c))
      .executeTakeFirst();
    if (!owner) return c.json({ error: 'Step not found' }, 404);

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

    // Checked against the RESULTING type, not the submitted one: a PUT that
    // omits `type` keeps the stored value, and a PUT that supplies it is the
    // whole attack — changing a benign step into `query_db` in place.
    const stepDenial = await assertStepTypesAllowed((c.get('user') as { id: string }).id, [
      { type: newType },
    ]);
    if (stepDenial) return c.json({ error: stepDenial }, 403);

    const validation = validateStepConfig(newType, newConfig);
    if (!validation.valid) {
      return c.json({ error: 'Invalid step configuration', errors: validation.errors }, 400);
    }

    const updates: Record<string, unknown> = {};
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
    if (body.type !== undefined) updates.type = body.type as any;
    if (body.name !== undefined) updates.name = body.name;
    if (body.on_error !== undefined) updates.on_error = body.on_error;
    if (body.config !== undefined)
      updates.config = JSON.stringify(validation.config ?? body.config);

    const updated = await db
      .updateTable('zv_flow_steps')
      .set(updates)
      .where('id', '=', stepId)
      .returningAll()
      .executeTakeFirst();

    return c.json({ step: updated });
  });

  // DELETE /:id/steps/:stepId — remove a single step. Re-compacts step_order
  // so the remaining steps stay 0..N-1 contiguous.
  app.delete('/:id/steps/:stepId', async (c) => {
    const flowId = c.req.param('id');
    const stepId = c.req.param('stepId');

    // Confirm the flow belongs to this tenant before touching its steps.
    const owner = await db
      .selectFrom('zv_flows')
      .select(['id'])
      .where('id', '=', flowId)
      .where('tenant_id', '=', tenantOf(c))
      .executeTakeFirst();
    if (!owner) return c.json({ error: 'Step not found' }, 404);

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
 *
 * Scoped to the writing tenant: a write in tenant A must only fire tenant A's
 * flows. Without this a record created in one tenant would trigger (and run) every
 * other tenant's matching flow — cross-tenant execution. The write pipeline passes
 * its resolved tenant id; when absent (single-tenant installs) it falls back to the
 * default tenant, which is also where those flows' backfilled tenant_id points.
 */
export async function triggerDataFlows(
  db: Database,
  collection: string,
  event: 'insert' | 'update' | 'delete',
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/private/HARDENING-9-PLAN.md H-01
  record: any,
  tenantId?: string | null,
): Promise<void> {
  try {
    // Map the data-route event vocabulary onto the trigger_type CHECK
    // constraint values stored in zv_flows.
    const triggerType =
      event === 'insert' ? 'on_create' : event === 'update' ? 'on_update' : 'on_delete';

    const flows = await db
      .selectFrom('zv_flows')
      .selectAll()
      .where('is_active', '=', true)
      .where('trigger_type', '=', triggerType)
      .where('tenant_id', '=', tenantId || DEFAULT_TENANT)
      .execute();

    for (const flow of flows) {
      const cfg = (
        typeof flow.trigger_config === 'string'
          ? JSON.parse(flow.trigger_config)
          : (flow.trigger_config ?? {})
      ) as { collection?: string };
      if (cfg.collection === collection) {
        executeFlow(db, flow.id, { collection, event, record }).catch(console.error);
      }
    }
  } catch (err) {
    // Flow triggering must not break data operations — the write already
    // succeeded and failing it now would be worse than the automation not running.
    //
    // But this was a bare `catch {}` with only that sentence in it, and the flow
    // lookup above carried `.catch(() => [])` on top, so an automation that
    // stopped firing produced no error, no warning, and no count. The operator
    // sees the event happen and no consequence, with nothing to search for. The
    // swallow stays; the silence does not.
    console.error(
      `[flows] trigger "${event}" on ${collection} did not run its automations:`,
      err instanceof Error ? err.message : err,
    );
  }
}
