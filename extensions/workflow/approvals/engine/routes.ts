import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Database } from '../../../../packages/engine/src/db/index.js';
import { checkPermission, getUserRoles } from '../../../../packages/engine/src/lib/permissions.js';

const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  collection: z.string().min(1),
  trigger_field: z.string().optional(),
  trigger_value: z.string().optional(),
  steps: z.array(
    z.object({
      name: z.string().min(1),
      approver_role: z.string().optional(),
      approver_user_id: z.string().optional(),
      deadline_hours: z.number().int().optional(),
      is_required: z.boolean().default(true),
    }),
  ).min(1),
});

const DecideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().optional(),
});

export function approvalsRoutes(db: Database, auth: any): Hono {
  const app = new Hono();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    await next();
  });

  // ── Approval Requests ─────────────────────────────────────────

  // GET / — List approval requests
  app.get('/', async (c) => {
    const user = c.get('user') as any;
    const { status, collection, my_pending, limit = '50', page = '1' } = c.req.query();
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = (db as any)
      .selectFrom('zv_approval_requests as r')
      .leftJoin('zv_approval_workflows as w', 'w.id', 'r.workflow_id')
      .leftJoin('user as u', 'u.id', 'r.requested_by')
      .select([
        'r.id', 'r.workflow_id', 'r.collection', 'r.record_id',
        'r.status', 'r.requested_at', 'r.completed_at', 'r.metadata',
        'w.name as workflow_name',
        'u.name as requested_by_name',
      ])
      .orderBy('r.requested_at', 'desc')
      .limit(parseInt(limit))
      .offset(offset);

    if (status) query = query.where('r.status', '=', status);
    if (collection) query = query.where('r.collection', '=', collection);

    // My pending — show requests where I need to act
    if (my_pending === 'true') {
      const userRoles = await getUserRoles(user.id);
      query = query
        .where('r.status', '=', 'pending')
        .leftJoin('zv_approval_steps as s', 's.id', 'r.current_step_id')
        .where((eb: any) =>
          eb.or([
            eb('s.approver_user_id', '=', user.id),
            ...(userRoles.length > 0
              ? [eb('s.approver_role', 'in', userRoles)]
              : []),
          ]),
        );
    }

    const requests = await query.execute();
    return c.json({ requests });
  });

  // POST / — Create approval request
  app.post(
    '/',
    zValidator(
      'json',
      z.object({
        workflow_id: z.string().uuid(),
        collection: z.string(),
        record_id: z.string(),
        metadata: z.record(z.any()).optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user') as any;
      const { workflow_id, collection, record_id, metadata } = c.req.valid('json');

      const workflow = await (db as any)
        .selectFrom('zv_approval_workflows')
        .selectAll()
        .where('id', '=', workflow_id)
        .where('is_active', '=', true)
        .executeTakeFirst();

      if (!workflow) return c.json({ error: 'Workflow not found or inactive' }, 404);

      // Get first step
      const firstStep = await (db as any)
        .selectFrom('zv_approval_steps')
        .selectAll()
        .where('workflow_id', '=', workflow_id)
        .orderBy('step_order')
        .limit(1)
        .executeTakeFirst();

      const request = await (db as any)
        .insertInto('zv_approval_requests')
        .values({
          workflow_id,
          collection,
          record_id,
          current_step_id: firstStep?.id || null,
          requested_by: user.id,
          metadata: JSON.stringify(metadata || {}),
        })
        .returningAll()
        .executeTakeFirst();

      return c.json({ request }, 202);
    },
  );

  // GET /:id — Get request details with steps & decisions
  app.get('/:id', async (c) => {
    const request = await (db as any)
      .selectFrom('zv_approval_requests as r')
      .leftJoin('zv_approval_workflows as w', 'w.id', 'r.workflow_id')
      .select([
        'r.id', 'r.collection', 'r.record_id', 'r.status',
        'r.requested_at', 'r.completed_at', 'r.metadata',
        'w.name as workflow_name',
      ])
      .where('r.id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found' }, 404);

    const steps = await (db as any)
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('workflow_id', '=', request.workflow_id)
      .orderBy('step_order')
      .execute();

    const decisions = await (db as any)
      .selectFrom('zv_approval_decisions as d')
      .leftJoin('user as u', 'u.id', 'd.decided_by')
      .select(['d.id', 'd.step_id', 'd.decision', 'd.comment', 'd.decided_at', 'u.name as decided_by_name'])
      .where('d.request_id', '=', request.id)
      .execute();

    return c.json({ request: { ...request, steps, decisions } });
  });

  // POST /:id/decide — Submit decision
  app.post('/:id/decide', zValidator('json', DecideSchema), async (c) => {
    const user = c.get('user') as any;
    const { decision, comment } = c.req.valid('json');
    const requestId = c.req.param('id');

    const request = await (db as any)
      .selectFrom('zv_approval_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found' }, 404);
    if (request.status !== 'pending') {
      return c.json({ error: 'Request is not pending' }, 400);
    }

    // Check if user can decide on current step
    const currentStep = await (db as any)
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('id', '=', request.current_step_id)
      .executeTakeFirst();

    if (!currentStep) return c.json({ error: 'No current step found' }, 400);

    const userRoles = await getUserRoles(user.id);
    const canDecide =
      currentStep.approver_user_id === user.id ||
      (currentStep.approver_role && userRoles.includes(currentStep.approver_role)) ||
      (await checkPermission(user.id, 'admin', '*'));

    if (!canDecide) return c.json({ error: 'You are not authorized to decide on this step' }, 403);

    // Record decision
    await (db as any)
      .insertInto('zv_approval_decisions')
      .values({
        request_id: requestId,
        step_id: currentStep.id,
        decision,
        decided_by: user.id,
        comment: comment || null,
      })
      .execute();

    if (decision === 'rejected') {
      // Reject the whole request
      await (db as any)
        .updateTable('zv_approval_requests')
        .set({ status: 'rejected', completed_at: new Date(), current_step_id: null })
        .where('id', '=', requestId)
        .execute();

      return c.json({ success: true, status: 'rejected' });
    }

    // Advance to next step (or complete)
    const nextStep = await (db as any)
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('workflow_id', '=', request.workflow_id)
      .where('step_order', '>', currentStep.step_order)
      .orderBy('step_order')
      .limit(1)
      .executeTakeFirst();

    if (nextStep) {
      await (db as any)
        .updateTable('zv_approval_requests')
        .set({ current_step_id: nextStep.id })
        .where('id', '=', requestId)
        .execute();
      return c.json({ success: true, status: 'pending', next_step: nextStep });
    } else {
      // All steps approved
      await (db as any)
        .updateTable('zv_approval_requests')
        .set({ status: 'approved', completed_at: new Date(), current_step_id: null })
        .where('id', '=', requestId)
        .execute();
      return c.json({ success: true, status: 'approved' });
    }
  });

  // POST /:id/cancel — Cancel a pending request
  app.post('/:id/cancel', async (c) => {
    const user = c.get('user') as any;
    const request = await (db as any)
      .selectFrom('zv_approval_requests')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!request) return c.json({ error: 'Request not found' }, 404);
    if (request.status !== 'pending') return c.json({ error: 'Request is not pending' }, 400);

    const isOwner = request.requested_by === user.id;
    const isAdmin = await checkPermission(user.id, 'admin', '*');

    if (!isOwner && !isAdmin) return c.json({ error: 'Unauthorized' }, 403);

    await (db as any)
      .updateTable('zv_approval_requests')
      .set({ status: 'cancelled', completed_at: new Date(), current_step_id: null })
      .where('id', '=', request.id)
      .execute();

    return c.json({ success: true });
  });

  // ── Workflow Management (Admin) ────────────────────────────────

  // GET /workflows — List workflows
  app.get('/workflows', async (c) => {
    const workflows = await (db as any)
      .selectFrom('zv_approval_workflows as w')
      .select([
        'w.id', 'w.name', 'w.description', 'w.collection',
        'w.trigger_field', 'w.trigger_value', 'w.is_active', 'w.created_at',
      ])
      .orderBy('w.created_at', 'desc')
      .execute();

    // Attach step counts
    const withStepCounts = await Promise.all(
      workflows.map(async (wf: any) => {
        const count = await (db as any)
          .selectFrom('zv_approval_steps')
          .select((eb: any) => eb.fn.count('id').as('count'))
          .where('workflow_id', '=', wf.id)
          .executeTakeFirst();
        return { ...wf, step_count: parseInt(count?.count ?? '0') };
      }),
    );

    return c.json({ workflows: withStepCounts });
  });

  // GET /workflows/:id — Get workflow with steps
  app.get('/workflows/:id', async (c) => {
    const workflow = await (db as any)
      .selectFrom('zv_approval_workflows')
      .selectAll()
      .where('id', '=', c.req.param('id'))
      .executeTakeFirst();

    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    const steps = await (db as any)
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('workflow_id', '=', workflow.id)
      .orderBy('step_order')
      .execute();

    return c.json({ workflow: { ...workflow, steps } });
  });

  // POST /workflows — Create workflow with steps
  app.post('/workflows', zValidator('json', CreateWorkflowSchema), async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { steps, ...workflowData } = c.req.valid('json');

    const workflow = await (db as any)
      .insertInto('zv_approval_workflows')
      .values({ ...workflowData, created_by: user.id })
      .returningAll()
      .executeTakeFirst();

    // Create steps
    for (let i = 0; i < steps.length; i++) {
      await (db as any)
        .insertInto('zv_approval_steps')
        .values({ ...steps[i], workflow_id: workflow.id, step_order: i })
        .execute();
    }

    const fullWorkflow = await (db as any)
      .selectFrom('zv_approval_steps')
      .selectAll()
      .where('workflow_id', '=', workflow.id)
      .orderBy('step_order')
      .execute();

    return c.json({ workflow: { ...workflow, steps: fullWorkflow } }, 201);
  });

  // PUT /workflows/:id — Update workflow
  app.put('/workflows/:id', zValidator('json', CreateWorkflowSchema.partial()), async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    const { steps, ...workflowData } = c.req.valid('json');
    const id = c.req.param('id');

    const workflow = await (db as any)
      .updateTable('zv_approval_workflows')
      .set({ ...workflowData, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);

    // Replace steps if provided
    if (steps) {
      await (db as any).deleteFrom('zv_approval_steps').where('workflow_id', '=', id).execute();
      for (let i = 0; i < steps.length; i++) {
        await (db as any)
          .insertInto('zv_approval_steps')
          .values({ ...steps[i], workflow_id: id, step_order: i })
          .execute();
      }
    }

    return c.json({ workflow });
  });

  // DELETE /workflows/:id — Delete workflow
  app.delete('/workflows/:id', async (c) => {
    const user = c.get('user') as any;
    if (!(await checkPermission(user.id, 'admin', '*'))) {
      return c.json({ error: 'Admin access required' }, 403);
    }

    await (db as any).deleteFrom('zv_approval_workflows').where('id', '=', c.req.param('id')).execute();
    return c.json({ success: true });
  });

  return app;
}
