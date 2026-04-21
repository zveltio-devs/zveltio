/**
 * Approval Workflows — /api/approvals/*
 *
 * Workflows define multi-step approval chains on a collection.
 * Requests are created when a record needs approval (manually or via flow trigger).
 * Each step can be assigned to a role or a specific user.
 *
 * Endpoints:
 *   GET    /api/approvals/workflows                — list workflows (admin)
 *   POST   /api/approvals/workflows                — create workflow (admin)
 *   PUT    /api/approvals/workflows/:id            — update workflow (admin)
 *   DELETE /api/approvals/workflows/:id            — delete workflow (admin)
 *
 *   GET    /api/approvals                          — list requests (admin + assignees)
 *   GET    /api/approvals/:id                      — request detail + steps + decisions
 *   POST   /api/approvals/submit                   — create new approval request
 *   POST   /api/approvals/:id/decide               — approve / reject current step
 *   POST   /api/approvals/:id/cancel               — cancel a pending request
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { checkPermission, getUserRoles } from '../lib/permissions.js';

// ── Schemas ────────────────────────────────────────────────────────────────

const WorkflowCreateSchema = z.object({
  name:          z.string().min(1).max(200),
  description:   z.string().max(1000).optional(),
  collection:    z.string().min(1).max(100),
  trigger_field: z.string().max(100).nullable().optional(),
  trigger_value: z.string().max(200).nullable().optional(),
  is_active:     z.boolean().optional(),
  steps: z.array(z.object({
    name:             z.string().min(1).max(200),
    step_order:       z.number().int().min(0),
    approver_role:    z.string().max(100).nullable().optional(),
    approver_user_id: z.string().nullable().optional(),
    deadline_hours:   z.number().int().min(1).nullable().optional(),
    is_required:      z.boolean().optional(),
  })).optional(),
});

const WorkflowUpdateSchema = WorkflowCreateSchema.partial();

const SubmitSchema = z.object({
  workflow_id:  z.string().uuid(),
  collection:   z.string().min(1).max(100),
  record_id:    z.string().min(1),
  metadata:     z.record(z.string(), z.unknown()).optional(),
});

const DecideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment:  z.string().max(2000).optional(),
});

// ── Route factory ──────────────────────────────────────────────────────────

export function approvalsRoutes(db: Database, auth: any) {
  // ── Helpers (auth-scoped) ────────────────────────────────────────────────

  async function getUser(c: any) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    return session?.user ?? null;
  }

  async function isAdmin(user: any): Promise<boolean> {
    if (!user) return false;
    if (user.role === 'god') return true;
    return checkPermission(user.id, 'approvals', 'manage').catch(() => false);
  }
  const app = new Hono();

  // ── Workflows ────────────────────────────────────────────────────────────

  /** GET /api/approvals/workflows */
  app.get('/workflows', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const workflows = await db
      .selectFrom('zv_approval_workflows as w')
      .selectAll('w')
      .orderBy('w.created_at desc')
      .execute();

    // Attach step counts
    const ids = workflows.map((w: any) => w.id);
    const stepCounts = ids.length
      ? await db
          .selectFrom('zv_approval_steps')
          .select(['workflow_id', db.fn.count('id').as('step_count')])
          .where('workflow_id', 'in', ids)
          .groupBy('workflow_id')
          .execute()
      : [];

    const countMap = Object.fromEntries(stepCounts.map((r: any) => [r.workflow_id, Number(r.step_count)]));

    return c.json({
      workflows: workflows.map((w: any) => ({ ...w, step_count: countMap[w.id] ?? 0 })),
    });
  });

  /** POST /api/approvals/workflows */
  app.post('/workflows', zValidator('json', WorkflowCreateSchema), async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await isAdmin(user))) return c.json({ error: 'Forbidden' }, 403);

    const data = c.req.valid('json');

    const workflow = await db
      .insertInto('zv_approval_workflows' as any)
      .values({
        name:          data.name,
        description:   data.description ?? null,
        collection:    data.collection,
        trigger_field: data.trigger_field ?? null,
        trigger_value: data.trigger_value ?? null,
        is_active:     data.is_active ?? true,
        created_by:    user.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Create steps if provided
    if (data.steps?.length) {
      await db
        .insertInto('zv_approval_steps' as any)
        .values(data.steps.map(s => ({
          workflow_id:      (workflow as any).id,
          step_order:       s.step_order,
          name:             s.name,
          approver_role:    s.approver_role ?? null,
          approver_user_id: s.approver_user_id ?? null,
          deadline_hours:   s.deadline_hours ?? null,
          is_required:      s.is_required ?? true,
        })))
        .execute();
    }

    return c.json({ workflow }, 201);
  });

  /** PUT /api/approvals/workflows/:id */
  app.put('/workflows/:id', zValidator('json', WorkflowUpdateSchema), async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await isAdmin(user))) return c.json({ error: 'Forbidden' }, 403);

    const { id } = c.req.param();
    const data = c.req.valid('json');

    const update: any = { updated_at: new Date() };
    if (data.name          !== undefined) update.name          = data.name;
    if (data.description   !== undefined) update.description   = data.description;
    if (data.trigger_field !== undefined) update.trigger_field = data.trigger_field;
    if (data.trigger_value !== undefined) update.trigger_value = data.trigger_value;
    if (data.is_active     !== undefined) update.is_active     = data.is_active;

    const workflow = await db
      .updateTable('zv_approval_workflows' as any)
      .set(update)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    // Replace steps if provided
    if (data.steps !== undefined) {
      await db.deleteFrom('zv_approval_steps' as any).where('workflow_id', '=', id).execute();
      if (data.steps.length) {
        await db
          .insertInto('zv_approval_steps' as any)
          .values(data.steps.map(s => ({
            workflow_id:      id,
            step_order:       s.step_order,
            name:             s.name,
            approver_role:    s.approver_role ?? null,
            approver_user_id: s.approver_user_id ?? null,
            deadline_hours:   s.deadline_hours ?? null,
            is_required:      s.is_required ?? true,
          })))
          .execute();
      }
    }

    return c.json({ workflow });
  });

  /** DELETE /api/approvals/workflows/:id */
  app.delete('/workflows/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await isAdmin(user))) return c.json({ error: 'Forbidden' }, 403);

    const { id } = c.req.param();
    await db.deleteFrom('zv_approval_workflows' as any).where('id', '=', id).execute();
    return c.json({ success: true });
  });

  // ── Requests: list ────────────────────────────────────────────────────────

  /** GET /api/approvals?status=pending&my_pending=true&limit=50&offset=0 */
  app.get('/', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const admin = await isAdmin(user);

    const limit  = Math.min(parseInt(c.req.query('limit')  ?? '50'),  200);
    const offset = parseInt(c.req.query('offset') ?? '0');
    const status = c.req.query('status');          // e.g. "pending" or "approved,rejected,cancelled"
    const myPending = c.req.query('my_pending') === 'true';

    let query = db
      .selectFrom('zv_approval_requests as r')
      .innerJoin('zv_approval_workflows as w', 'w.id', 'r.workflow_id')
      .leftJoin('zv_approval_steps as cs', 'cs.id', 'r.current_step_id')
      .leftJoin('user as u', 'u.id', 'r.requested_by')
      .select([
        'r.id',
        'r.collection',
        'r.record_id',
        'r.status',
        'r.requested_by',
        'r.requested_at',
        'r.completed_at',
        'r.metadata',
        'r.current_step_id',
        'w.name as workflow_name',
        'cs.name as current_step_name',
        'cs.approver_role as current_step_role',
        sql<string>`COALESCE(u.name, u.email)`.as('requester_name'),
      ])
      .orderBy('r.requested_at desc')
      .limit(limit)
      .offset(offset);

    // Non-admins see only their own requests + requests where they are the approver
    if (!admin) {
      const userRoles = await getUserRoles(user.id);
      query = query.where(eb =>
        eb.or([
          eb('r.requested_by', '=', user.id),
          eb('cs.approver_user_id', '=', user.id),
          ...(userRoles.length > 0 ? [eb('cs.approver_role', 'in', userRoles as any)] : []),
        ])
      );
    }

    // Filter by status
    if (status) {
      const statuses = status.split(',').map(s => s.trim());
      query = query.where('r.status', 'in', statuses as any);
    }

    // My pending = requests where I need to decide
    if (myPending) {
      const userRoles = await getUserRoles(user.id);
      query = query
        .where('r.status', '=', 'pending')
        .where(eb =>
          eb.or([
            eb('cs.approver_user_id', '=', user.id),
            ...(userRoles.length > 0 ? [eb('cs.approver_role', 'in', userRoles as any)] : []),
          ])
        );
    }

    const requests = await query.execute();

    // Count total (same filters without limit/offset)
    const countResult = await db
      .selectFrom('zv_approval_requests as r')
      .select((eb) => eb.fn.count('r.id' as any).as('total'))
      .executeTakeFirst();

    return c.json({ requests, total: Number(countResult?.total ?? 0) });
  });

  // ── Submit new request ────────────────────────────────────────────────────

  /** POST /api/approvals/submit */
  app.post('/submit', zValidator('json', SubmitSchema), async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const { workflow_id, collection, record_id, metadata } = c.req.valid('json');

    // Load workflow + first step
    const workflow = await db
      .selectFrom('zv_approval_workflows')
      .selectAll()
      .where('id', '=', workflow_id)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!workflow) return c.json({ error: 'Workflow not found or inactive' }, 404);
    if ((workflow as any).collection !== collection) {
      return c.json({ error: 'Workflow collection mismatch' }, 400);
    }

    // Check for existing pending request on same record + workflow
    const existing = await db
      .selectFrom('zv_approval_requests')
      .select('id')
      .where('workflow_id', '=', workflow_id)
      .where('record_id', '=', record_id)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (existing) return c.json({ error: 'A pending request already exists for this record' }, 409);

    // Get first step
    const firstStep = await db
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('workflow_id', '=', workflow_id)
      .orderBy('step_order asc')
      .limit(1)
      .executeTakeFirst();

    const request = await db
      .insertInto('zv_approval_requests' as any)
      .values({
        workflow_id,
        collection,
        record_id,
        current_step_id: firstStep ? (firstStep as any).id : null,
        status:          'pending',
        requested_by:    user.id,
        metadata:        JSON.stringify(metadata ?? {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return c.json({ request }, 201);
  });

  // ── Request detail ────────────────────────────────────────────────────────

  /** GET /api/approvals/:id */
  app.get('/:id', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const admin = await isAdmin(user);
    const { id } = c.req.param();

    const request = await db
      .selectFrom('zv_approval_requests as r')
      .innerJoin('zv_approval_workflows as w', 'w.id', 'r.workflow_id')
      .leftJoin('user as u', 'u.id', 'r.requested_by')
      .select([
        'r.id', 'r.collection', 'r.record_id', 'r.status',
        'r.requested_by', 'r.requested_at', 'r.completed_at',
        'r.metadata', 'r.current_step_id',
        'w.name as workflow_name', 'w.id as workflow_id',
        sql<string>`COALESCE(u.name, u.email)`.as('requester_name'),
      ])
      .where('r.id', '=', id)
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found' }, 404);

    // Access check: own request or admin
    if (!admin && (request as any).requested_by !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    // Load all steps with decisions
    const steps = await db
      .selectFrom('zv_approval_steps as s')
      .leftJoin('zv_approval_decisions as d', join =>
        join.onRef('d.step_id', '=', 's.id').on('d.request_id', '=', id)
      )
      .leftJoin('user as du', 'du.id', 'd.decided_by')
      .select([
        's.id', 's.step_order', 's.name',
        's.approver_role', 's.approver_user_id',
        's.deadline_hours', 's.is_required',
        'd.decision',
        'd.comment',
        'd.decided_at',
        sql<string>`COALESCE(du.name, du.email)`.as('decider_name'),
      ])
      .where('s.workflow_id', '=', (request as any).workflow_id)
      .orderBy('s.step_order asc')
      .execute();

    return c.json({ request, steps });
  });

  // ── Decide ────────────────────────────────────────────────────────────────

  /** POST /api/approvals/:id/decide */
  app.post('/:id/decide', zValidator('json', DecideSchema), async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const admin = await isAdmin(user);
    const { id } = c.req.param();
    const { decision, comment } = c.req.valid('json');

    const request = await db
      .selectFrom('zv_approval_requests as r')
      .selectAll()
      .where('r.id', '=', id)
      .where('r.status', '=', 'pending')
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found or not pending' }, 404);

    const currentStep = (request as any).current_step_id
      ? await db
          .selectFrom('zv_approval_steps')
          .selectAll()
          .where('id', '=', (request as any).current_step_id)
          .executeTakeFirst()
      : null;

    // Check if user is allowed to decide this step
    if (!admin && currentStep) {
      const step = currentStep as any;
      const userRoles = await getUserRoles(user.id);
      const isAssigned =
        step.approver_user_id === user.id ||
        (step.approver_role && userRoles.includes(step.approver_role));
      if (!isAssigned) return c.json({ error: 'You are not assigned to this step' }, 403);
    }

    // Record decision
    await db
      .insertInto('zv_approval_decisions' as any)
      .values({
        request_id: id,
        step_id:    (request as any).current_step_id,
        decision,
        decided_by: user.id,
        comment:    comment ?? null,
      })
      .execute();

    if (decision === 'rejected') {
      // Rejected → entire request rejected
      await db
        .updateTable('zv_approval_requests' as any)
        .set({ status: 'rejected', completed_at: new Date() })
        .where('id', '=', id)
        .execute();

      return c.json({ status: 'rejected' });
    }

    // Approved → advance to next step
    const nextStep = currentStep
      ? await db
          .selectFrom('zv_approval_steps')
          .selectAll()
          .where('workflow_id', '=', (currentStep as any).workflow_id)
          .where('step_order', '>', (currentStep as any).step_order)
          .orderBy('step_order asc')
          .limit(1)
          .executeTakeFirst()
      : null;

    if (nextStep) {
      await db
        .updateTable('zv_approval_requests' as any)
        .set({ current_step_id: (nextStep as any).id })
        .where('id', '=', id)
        .execute();
      return c.json({ status: 'pending', next_step: nextStep });
    }

    // All steps approved → request fully approved
    await db
      .updateTable('zv_approval_requests' as any)
      .set({ status: 'approved', completed_at: new Date(), current_step_id: null })
      .where('id', '=', id)
      .execute();

    return c.json({ status: 'approved' });
  });

  // ── Cancel ────────────────────────────────────────────────────────────────

  /** POST /api/approvals/:id/cancel */
  app.post('/:id/cancel', async (c) => {
    const user = await getUser(c);
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    const admin = await isAdmin(user);
    const { id } = c.req.param();

    const request = await db
      .selectFrom('zv_approval_requests')
      .select(['id', 'requested_by', 'status'])
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found or not pending' }, 404);

    // Only owner or admin can cancel
    if (!admin && (request as any).requested_by !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    await db
      .updateTable('zv_approval_requests' as any)
      .set({ status: 'cancelled', completed_at: new Date() })
      .where('id', '=', id)
      .execute();

    return c.json({ success: true });
  });

  return app;
}
