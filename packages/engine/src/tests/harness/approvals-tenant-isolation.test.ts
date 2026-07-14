/**
 * Phase C — approvals subsystem tenant isolation. Regression: zv_approval_*
 * tables had no tenant_id and routes/approvals.ts queried by id on the raw pool
 * db, so any tenant could read/act on another tenant's workflows/requests by id
 * (cross-tenant IDOR). The handlers now scope every query by the request tenant.
 *
 * The harness runs as the default tenant, so a row inserted directly with a
 * DIFFERENT tenant_id stands in for "another tenant's data".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';

d('approvals tenant isolation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let godUserId = '';
  let myWorkflowId = '';
  let foreignWorkflowId = '';
  let foreignRequestId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const godUser = await db.selectFrom('user').select('id').executeTakeFirstOrThrow();
    godUserId = godUser.id;

    // A workflow created through the API — gets the default (current) tenant.
    const wfRes = await app.request('/api/approvals/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'mine',
        collection: 'contacts',
        is_active: true,
        steps: [{ step_order: 1, name: 'review', approver_role: 'admin' }],
      }),
    });
    expect(wfRes.status).toBe(201);
    myWorkflowId = ((await wfRes.json()) as { workflow: { id: string } }).workflow.id;

    // Directly insert a workflow + pending request belonging to ANOTHER tenant.
    const fw = await db
      .insertInto('zv_approval_workflows')
      .values({ name: 'foreign', collection: 'contacts', is_active: true, tenant_id: OTHER_TENANT })
      .returningAll()
      .executeTakeFirstOrThrow();
    foreignWorkflowId = fw.id as string;
    const fr = await db
      .insertInto('zv_approval_requests')
      .values({
        workflow_id: fw.id,
        collection: 'contacts',
        record_id: 'rec-foreign',
        status: 'pending',
        requested_by: godUserId,
        metadata: '{}',
        tenant_id: OTHER_TENANT,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    foreignRequestId = fr.id as string;
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_approval_requests')
      .where('tenant_id', '=', OTHER_TENANT)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_approval_workflows')
      .where('tenant_id', '=', OTHER_TENANT)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_approval_steps')
      .where('workflow_id', '=', myWorkflowId)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_approval_requests')
      .where('workflow_id', '=', myWorkflowId)
      .execute()
      .catch(() => {});
    await db
      .deleteFrom('zv_approval_workflows')
      .where('id', '=', myWorkflowId)
      .execute()
      .catch(() => {});
  });

  it('single-tenant: workflow list shows own workflow, hides the other tenant’s', async () => {
    const res = await app.request('/api/approvals/workflows', { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { workflows: { id: string }[] }).workflows.map((w) => w.id);
    expect(ids).toContain(myWorkflowId);
    expect(ids).not.toContain(foreignWorkflowId);
  });

  it('single-tenant: submit + list a request works', async () => {
    const submit = await app.request('/api/approvals/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        workflow_id: myWorkflowId,
        collection: 'contacts',
        record_id: 'rec-1',
      }),
    });
    expect(submit.status).toBe(201);

    const list = await app.request('/api/approvals', { headers: { cookie } });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { requests: { record_id: string }[] };
    expect(body.requests.some((r) => r.record_id === 'rec-1')).toBe(true);
    // the other tenant's pending request must NOT appear
    expect(body.requests.some((r) => r.record_id === 'rec-foreign')).toBe(false);
  });

  it('cross-tenant: GET /:id of another tenant’s request → 404', async () => {
    const res = await app.request(`/api/approvals/${foreignRequestId}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('cross-tenant: deciding another tenant’s request → 404 (not found in this tenant)', async () => {
    const res = await app.request(`/api/approvals/${foreignRequestId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(404);
    // the foreign request is still pending (untouched)
    const still = await db
      .selectFrom('zv_approval_requests')
      .select('status')
      .where('id', '=', foreignRequestId)
      .executeTakeFirst();
    expect(still?.status).toBe('pending');
  });
});
