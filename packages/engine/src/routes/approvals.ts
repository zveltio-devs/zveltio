/**
 * Approval Workflows
 *
 * POST   /api/approvals                    — create approval request
 * GET    /api/approvals                    — list requests (with filters)
 * GET    /api/approvals/:id                — get request + step history
 * POST   /api/approvals/:id/decide         — approve / reject current step
 * POST   /api/approvals/:id/cancel         — cancel pending request
 * GET    /api/approvals/workflows          — list workflows (admin)
 * GET    /api/approvals/workflows/:id      — get workflow + steps (admin)
 * POST   /api/approvals/workflows          — create workflow (admin)
 * PUT    /api/approvals/workflows/:id      — update workflow (admin)
 * DELETE /api/approvals/workflows/:id      — delete workflow (admin)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { checkPermission, getUserRoles } from '../lib/permissions.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ApprovalStepSchema = z.object({
  name: z.string().min(1),
  approver_role: z.string().optional(),
  approver_user_id: z.string().optional(),
  deadline_hours: z.number().int().positive().optional(),
  is_required: z.boolean().default(true),
});

const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  collection: z.string().min(1),
  trigger_field: z.string().optional(),
  trigger_value: z.string().optional(),
  steps: z.array(ApprovalStepSchema).min(1),
});

const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  collection: z.string().min(1).optional(),
  trigger_field: z.string().optional().nullable(),
  trigger_value: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
  steps: z.array(ApprovalStepSchema).min(1).optional(),
});

const CreateRequestSchema = z.object({
  workflow_id: z.string().uuid(),
  collection: z.string().min(1),
  record_id: z.string().min(1),
  metadata: z.record(z.string(), z.any()).optional(),
});

const DecideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().optional(),
});

// ── Webhook helper ────────────────────────────────────────────────────────────

async function fireWebhook(event: string, data: Record<string, any>): Promise<void> {
  try {
    const { WebhookManager } = await import('../lib/webhooks.js');
    await WebhookManager.trigger(event as any, data.collection || 'approvals', {
      id: data.request_id || data.id || 'unknown',
      ...data,
    });
  } catch { /* non-critical */ }
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function approvalsRoutes(db: Database, _auth: any): Hono {
  const app = new Hono<{ Variables: { user: any } }>();

  // Auth middleware
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', session.user);
    return next();
  });

  // ── Approval Requests ──────────────────────────────────────────────────────

  // GET / — list approval requests
  app.get('/', async (c) => {
    const user = c.get('user');
    const { status, collection, my_pending, limit = '50', offset = '0' } = c.req.query();

    try {
      const isAdmin = await checkPermission(user.id, 'admin', '*');
      const conditions: string[] = [];

      if (status) conditions.push(`ar.status = '${status}'`);
      if (collection) conditions.push(`ar.collection = '${collection}'`);

      if (my_pending === 'true') {
        const userRoles = await getUserRoles(user.id);
        const roleList = userRoles.length > 0 ? userRoles.map((r) => `'${r}'`).join(',') : "'__none__'";
        conditions.push(`ar.status = 'pending' AND ar.current_step_id IN (
          SELECT s.id FROM zv_approval_steps s
          WHERE s.approver_user_id = '${user.id}' OR s.approver_role IN (${roleList})
        )`);
      } else if (!isAdmin) {
        const userRoles = await getUserRoles(user.id);
        const roleList = userRoles.length > 0 ? userRoles.map((r) => `'${r}'`).join(',') : "'__none__'";
        conditions.push(`(ar.requested_by = '${user.id}' OR (ar.status = 'pending' AND ar.current_step_id IN (
          SELECT s.id FROM zv_approval_steps s
          WHERE s.approver_user_id = '${user.id}' OR s.approver_role IN (${roleList})
        )))`);
      }

      const whereClause = conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '';

      const result = await sql<any>`
        SELECT ar.id::text, ar.workflow_id::text, w.name AS workflow_name,
               ar.collection, ar.record_id, ar.current_step_id::text,
               s.name AS current_step_name, ar.status, ar.requested_by,
               u.name AS requester_name, ar.requested_at, ar.completed_at, ar.metadata
        FROM zv_approval_requests ar
        JOIN zv_approval_workflows w ON w.id = ar.workflow_id
        LEFT JOIN zv_approval_steps s ON s.id = ar.current_step_id
        LEFT JOIN "user" u ON u.id = ar.requested_by
        WHERE 1=1 ${sql.raw(whereClause)}
        ORDER BY ar.requested_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `.execute(db);

      const countResult = await sql<{ count: string }>`
        SELECT COUNT(*)::text AS count
        FROM zv_approval_requests ar
        LEFT JOIN zv_approval_steps s ON s.id = ar.current_step_id
        WHERE 1=1 ${sql.raw(whereClause)}
      `.execute(db);

      return c.json({ requests: result.rows, total: Number(countResult.rows[0]?.count || 0) });
    } catch (err) {
      return c.json({ error: 'Failed to fetch approval requests' }, 500);
    }
  });

  // POST / — create approval request
  app.post('/', zValidator('json', CreateRequestSchema), async (c) => {
    const user = c.get('user');
    const data = c.req.valid('json');

    try {
      const wf = await sql<any>`
        SELECT * FROM zv_approval_workflows WHERE id = ${data.workflow_id} AND is_active = true
      `.execute(db);
      if (wf.rows.length === 0) return c.json({ error: 'Workflow not found or inactive' }, 404);

      const existing = await sql`
        SELECT id FROM zv_approval_requests
        WHERE collection = ${data.collection} AND record_id = ${data.record_id} AND status = 'pending'
      `.execute(db);
      if (existing.rows.length > 0) return c.json({ error: 'A pending request already exists for this record' }, 400);

      const firstStep = await sql<any>`
        SELECT * FROM zv_approval_steps WHERE workflow_id = ${data.workflow_id} ORDER BY step_order ASC LIMIT 1
      `.execute(db);
      if (firstStep.rows.length === 0) return c.json({ error: 'Workflow has no steps defined' }, 400);

      const result = await sql<{ id: string }>`
        INSERT INTO zv_approval_requests (workflow_id, collection, record_id, current_step_id, status, requested_by, metadata)
        VALUES (${data.workflow_id}, ${data.collection}, ${data.record_id}, ${firstStep.rows[0].id}, 'pending', ${user.id}, ${JSON.stringify(data.metadata || {})}::jsonb)
        RETURNING id::text
      `.execute(db);

      const requestId = result.rows[0].id;
      await fireWebhook('approval.created', { request_id: requestId, workflow_id: data.workflow_id, collection: data.collection, record_id: data.record_id, requested_by: user.id });

      return c.json({ id: requestId, success: true }, 201);
    } catch (err) {
      return c.json({ error: 'Failed to create approval request' }, 500);
    }
  });

  // GET /:id — get request details with steps
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const requestResult = await sql<any>`
        SELECT ar.id::text, ar.workflow_id::text, w.name AS workflow_name,
               ar.collection, ar.record_id, ar.current_step_id::text,
               s.name AS current_step_name, ar.status, ar.requested_by,
               u.name AS requester_name, u.email AS requester_email,
               ar.requested_at, ar.completed_at, ar.metadata
        FROM zv_approval_requests ar
        JOIN zv_approval_workflows w ON w.id = ar.workflow_id
        LEFT JOIN zv_approval_steps s ON s.id = ar.current_step_id
        LEFT JOIN "user" u ON u.id = ar.requested_by
        WHERE ar.id = ${id}
      `.execute(db);

      if (requestResult.rows.length === 0) return c.json({ error: 'Approval request not found' }, 404);
      const request = requestResult.rows[0];

      const stepsResult = await sql<any>`
        SELECT s.id::text, s.step_order, s.name, s.approver_role, s.approver_user_id::text,
               u.name AS approver_name, s.deadline_hours, s.is_required,
               d.decision, d.decided_by::text, du.name AS decider_name, d.comment, d.decided_at
        FROM zv_approval_steps s
        LEFT JOIN zv_approval_decisions d ON d.step_id = s.id AND d.request_id = ${id}
        LEFT JOIN "user" u ON u.id = s.approver_user_id
        LEFT JOIN "user" du ON du.id = d.decided_by
        WHERE s.workflow_id = ${request.workflow_id}
        ORDER BY s.step_order ASC
      `.execute(db);

      return c.json({ request, steps: stepsResult.rows });
    } catch (err) {
      return c.json({ error: 'Failed to fetch approval request' }, 500);
    }
  });

  // POST /:id/decide — submit decision
  app.post('/:id/decide', zValidator('json', DecideSchema), async (c) => {
    const user = c.get('user');
    const requestId = c.req.param('id');
    const data = c.req.valid('json');

    try {
      const requestResult = await sql<any>`
        SELECT ar.id::text, ar.workflow_id::text, ar.current_step_id::text,
               s.name AS current_step_name, s.step_order AS current_step_order,
               ar.status, s.approver_role, s.approver_user_id::text
        FROM zv_approval_requests ar
        LEFT JOIN zv_approval_steps s ON s.id = ar.current_step_id
        WHERE ar.id = ${requestId}
      `.execute(db);

      if (requestResult.rows.length === 0) return c.json({ error: 'Approval request not found' }, 404);
      const request = requestResult.rows[0];
      if (request.status !== 'pending') return c.json({ error: 'Request is not pending' }, 400);
      if (!request.current_step_id) return c.json({ error: 'No current step' }, 400);

      const isAdmin = await checkPermission(user.id, 'admin', '*');
      const isAssigned = request.approver_user_id === user.id;
      const hasRole = request.approver_role
        ? await checkPermission(user.id, request.approver_role, 'approve')
        : false;

      if (!isAdmin && !isAssigned && !hasRole) {
        return c.json({ error: 'You do not have permission to approve this step' }, 403);
      }

      const existing = await sql`
        SELECT id FROM zv_approval_decisions WHERE request_id = ${requestId} AND step_id = ${request.current_step_id}
      `.execute(db);
      if (existing.rows.length > 0) return c.json({ error: 'This step has already been decided' }, 400);

      await sql`
        INSERT INTO zv_approval_decisions (request_id, step_id, decision, decided_by, comment)
        VALUES (${requestId}, ${request.current_step_id}, ${data.decision}, ${user.id}, ${data.comment || null})
      `.execute(db);

      if (data.decision === 'rejected') {
        await sql`UPDATE zv_approval_requests SET status = 'rejected', completed_at = NOW() WHERE id = ${requestId}`.execute(db);
        await fireWebhook('approval.decided', { request_id: requestId, decision: 'rejected', decided_by: user.id });
        return c.json({ success: true, status: 'rejected' });
      }

      const nextStep = await sql<any>`
        SELECT * FROM zv_approval_steps
        WHERE workflow_id = ${request.workflow_id} AND step_order > ${request.current_step_order || 0}
        ORDER BY step_order ASC LIMIT 1
      `.execute(db);

      if (nextStep.rows.length > 0) {
        await sql`UPDATE zv_approval_requests SET current_step_id = ${nextStep.rows[0].id} WHERE id = ${requestId}`.execute(db);
        await fireWebhook('approval.step_approved', { request_id: requestId, step_id: request.current_step_id, decided_by: user.id });
        return c.json({ success: true, status: 'pending', message: `Moved to: ${nextStep.rows[0].name}` });
      }

      await sql`UPDATE zv_approval_requests SET status = 'approved', completed_at = NOW() WHERE id = ${requestId}`.execute(db);
      await fireWebhook('approval.decided', { request_id: requestId, decision: 'approved', decided_by: user.id });
      return c.json({ success: true, status: 'approved', message: 'Fully approved' });
    } catch (err) {
      return c.json({ error: 'Failed to process decision' }, 500);
    }
  });

  // POST /:id/cancel
  app.post('/:id/cancel', async (c) => {
    const user = c.get('user');
    const requestId = c.req.param('id');

    try {
      const requestResult = await sql<{ id: string; status: string; requested_by: string | null }>`
        SELECT id::text, status, requested_by::text FROM zv_approval_requests WHERE id = ${requestId}
      `.execute(db);

      if (requestResult.rows.length === 0) return c.json({ error: 'Approval request not found' }, 404);
      const request = requestResult.rows[0];
      if (request.status !== 'pending') return c.json({ error: 'Only pending requests can be cancelled' }, 400);

      const isAdmin = await checkPermission(user.id, 'admin', '*');
      if (!isAdmin && request.requested_by !== user.id) return c.json({ error: 'Only the requester or admin can cancel' }, 403);

      await sql`UPDATE zv_approval_requests SET status = 'cancelled', completed_at = NOW() WHERE id = ${requestId}`.execute(db);
      await fireWebhook('approval.cancelled', { request_id: requestId, cancelled_by: user.id });
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to cancel request' }, 500);
    }
  });

  // ── Workflow Management (admin) ────────────────────────────────────────────

  app.get('/workflows', async (c) => {
    const user = c.get('user');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    try {
      const workflows = await sql<any>`
        SELECT w.id::text, w.name, w.description, w.collection, w.trigger_field, w.trigger_value,
               w.is_active, COUNT(s.id) AS step_count, w.created_by::text, w.created_at, w.updated_at
        FROM zv_approval_workflows w
        LEFT JOIN zv_approval_steps s ON s.workflow_id = w.id
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `.execute(db);
      return c.json({ workflows: workflows.rows });
    } catch (err) {
      return c.json({ error: 'Failed to fetch workflows' }, 500);
    }
  });

  app.get('/workflows/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    try {
      const wf = await sql<any>`SELECT * FROM zv_approval_workflows WHERE id = ${id}`.execute(db);
      if (wf.rows.length === 0) return c.json({ error: 'Workflow not found' }, 404);
      const steps = await sql<any>`SELECT * FROM zv_approval_steps WHERE workflow_id = ${id} ORDER BY step_order ASC`.execute(db);
      return c.json({ workflow: wf.rows[0], steps: steps.rows });
    } catch (err) {
      return c.json({ error: 'Failed to fetch workflow' }, 500);
    }
  });

  app.post('/workflows', zValidator('json', CreateWorkflowSchema), async (c) => {
    const user = c.get('user');
    const data = c.req.valid('json');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    try {
      const wfResult = await sql<{ id: string }>`
        INSERT INTO zv_approval_workflows (name, description, collection, trigger_field, trigger_value, created_by)
        VALUES (${data.name}, ${data.description || null}, ${data.collection}, ${data.trigger_field || null}, ${data.trigger_value || null}, ${user.id})
        RETURNING id::text
      `.execute(db);

      const workflowId = wfResult.rows[0].id;
      for (let i = 0; i < data.steps.length; i++) {
        const step = data.steps[i];
        await sql`
          INSERT INTO zv_approval_steps (workflow_id, step_order, name, approver_role, approver_user_id, deadline_hours, is_required)
          VALUES (${workflowId}, ${i}, ${step.name}, ${step.approver_role || null}, ${step.approver_user_id || null}, ${step.deadline_hours || null}, ${step.is_required})
        `.execute(db);
      }

      return c.json({ id: workflowId, success: true }, 201);
    } catch (err) {
      return c.json({ error: 'Failed to create workflow' }, 500);
    }
  });

  app.put('/workflows/:id', zValidator('json', UpdateWorkflowSchema), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    try {
      const existing = await sql`SELECT id FROM zv_approval_workflows WHERE id = ${id}`.execute(db);
      if (existing.rows.length === 0) return c.json({ error: 'Workflow not found' }, 404);

      await sql`
        UPDATE zv_approval_workflows SET
          name = COALESCE(${data.name ?? null}, name),
          description = COALESCE(${data.description ?? null}, description),
          collection = COALESCE(${data.collection ?? null}, collection),
          trigger_field = COALESCE(${data.trigger_field ?? null}, trigger_field),
          trigger_value = COALESCE(${data.trigger_value ?? null}, trigger_value),
          is_active = COALESCE(${data.is_active ?? null}, is_active),
          updated_at = NOW()
        WHERE id = ${id}
      `.execute(db);

      if (data.steps) {
        await sql`DELETE FROM zv_approval_steps WHERE workflow_id = ${id}`.execute(db);
        for (let i = 0; i < data.steps.length; i++) {
          const step = data.steps[i];
          await sql`
            INSERT INTO zv_approval_steps (workflow_id, step_order, name, approver_role, approver_user_id, deadline_hours, is_required)
            VALUES (${id}, ${i}, ${step.name}, ${step.approver_role || null}, ${step.approver_user_id || null}, ${step.deadline_hours || null}, ${step.is_required})
          `.execute(db);
        }
      }

      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to update workflow' }, 500);
    }
  });

  app.delete('/workflows/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const isAdmin = await checkPermission(user.id, 'admin', '*');
    if (!isAdmin) return c.json({ error: 'Admin access required' }, 403);

    try {
      const pending = await sql<{ count: number }>`
        SELECT COUNT(*)::int AS count FROM zv_approval_requests WHERE workflow_id = ${id} AND status = 'pending'
      `.execute(db);
      if ((pending.rows[0]?.count || 0) > 0) return c.json({ error: 'Cannot delete workflow with pending requests' }, 400);

      const result = await sql`DELETE FROM zv_approval_workflows WHERE id = ${id} RETURNING id`.execute(db);
      if (result.rows.length === 0) return c.json({ error: 'Workflow not found' }, 404);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: 'Failed to delete workflow' }, 500);
    }
  });

  return app;
}
