/**
 * Phase C — approvals routes: workflow CRUD plus the request lifecycle
 * (submit → detail → decide / cancel) that the base approvals tests leave
 * uncovered. Drives routes/approvals.ts through the in-process app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = 'user';

d('approvals lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let workflowId = '';
  let requestId = '';
  let cancelReqId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (workflowId) {
      await sql`DELETE FROM zv_approval_decisions WHERE request_id IN (SELECT id FROM zv_approval_requests WHERE workflow_id = ${workflowId})`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_approval_requests WHERE workflow_id = ${workflowId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_approval_steps WHERE workflow_id = ${workflowId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_approval_workflows WHERE id = ${workflowId}`
        .execute(db)
        .catch(() => {});
    }
  });

  it('creates a workflow with a step (POST /workflows)', async () => {
    const res = await app.request(
      '/api/approvals/workflows',
      json('POST', {
        name: 'Harness WF',
        collection: COLLECTION,
        is_active: true,
        steps: [{ name: 'Manager', step_order: 0, approver_role: 'god', is_required: true }],
      }),
    );
    expect(res.status).toBe(201);
    workflowId = ((await res.json()) as { workflow: { id: string } }).workflow.id;
    expect(workflowId).toBeTruthy();
  });

  it('lists workflows (GET /workflows)', async () => {
    const res = await app.request('/api/approvals/workflows', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { workflows: unknown[] }).workflows.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('updates a workflow (PUT /workflows/:id)', async () => {
    const res = await app.request(
      `/api/approvals/workflows/${workflowId}`,
      json('PUT', { description: 'updated' }),
    );
    expect(res.status).toBe(200);
  });

  it('submits an approval request (POST /submit)', async () => {
    const res = await app.request(
      '/api/approvals/submit',
      json('POST', { workflow_id: workflowId, collection: COLLECTION, record_id: 'rec-1' }),
    );
    expect(res.status).toBe(201);
    requestId = ((await res.json()) as { request: { id: string } }).request.id;
    expect(requestId).toBeTruthy();
  });

  it('rejects a collection mismatch on submit', async () => {
    const res = await app.request(
      '/api/approvals/submit',
      json('POST', {
        workflow_id: workflowId,
        collection: 'not_the_collection',
        record_id: 'rec-x',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate pending request', async () => {
    const res = await app.request(
      '/api/approvals/submit',
      json('POST', { workflow_id: workflowId, collection: COLLECTION, record_id: 'rec-1' }),
    );
    expect([400, 409]).toContain(res.status);
  });

  it('reads a request detail (GET /:id)', async () => {
    const res = await app.request(`/api/approvals/${requestId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: { id: string; status: string } };
    expect(body.request.id).toBe(requestId);
  });

  it('404s an unknown request detail', async () => {
    const res = await app.request('/api/approvals/00000000-0000-4000-8000-0000000000aa', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('decides (approves) the request (POST /:id/decide)', async () => {
    const res = await app.request(
      `/api/approvals/${requestId}/decide`,
      json('POST', { decision: 'approved', comment: 'ok' }),
    );
    expect(res.status).toBe(200);
  });

  it('submits a second request and cancels it (POST /:id/cancel)', async () => {
    const submit = await app.request(
      '/api/approvals/submit',
      json('POST', { workflow_id: workflowId, collection: COLLECTION, record_id: 'rec-2' }),
    );
    expect(submit.status).toBe(201);
    cancelReqId = ((await submit.json()) as { request: { id: string } }).request.id;
    const res = await app.request(`/api/approvals/${cancelReqId}/cancel`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it('rejects unauthenticated workflow listing', async () => {
    const res = await app.request('/api/approvals/workflows');
    expect(res.status).toBe(401);
  });

  it('deletes the workflow (DELETE /workflows/:id)', async () => {
    // Clean pending requests first so the delete isn't blocked by FKs.
    await sql`DELETE FROM zv_approval_decisions WHERE request_id IN (SELECT id FROM zv_approval_requests WHERE workflow_id = ${workflowId})`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zv_approval_requests WHERE workflow_id = ${workflowId}`
      .execute(db)
      .catch(() => {});
    const res = await app.request(`/api/approvals/workflows/${workflowId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    workflowId = '';
  });
});
