/**
 * Phase C — /api/schema/branches (routes/schema-branches.ts + DDLManager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const BRANCH = `harness-branch-${Date.now()}`;

d('schema branches routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let branchId = '';
  let branchSchema = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    if (branchId) {
      await db
        .deleteFrom('zv_schema_branches')
        .where('id', '=', branchId)
        .execute()
        .catch(() => {});
    }
    if (branchSchema) {
      await sql`DROP SCHEMA IF EXISTS ${sql.id(branchSchema)} CASCADE`.execute(db).catch(() => {});
    }
  });

  it('GET /api/schema/branches lists schema branches', async () => {
    const res = await app.request('/api/schema/branches', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: unknown[] };
    expect(Array.isArray(body.branches)).toBe(true);
  });

  it('POST /api/schema/branches provisions a branch schema', async () => {
    const res = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: BRANCH, description: 'harness branch' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { branch: { id: string }; schema: string };
    branchId = body.branch.id;
    branchSchema = body.schema;
    expect(branchSchema).toContain('branch_');
  });

  it('GET /api/schema/branches/:id returns branch detail', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branch: { id: string; name: string } };
    expect(body.branch.id).toBe(branchId);
    expect(body.branch.name).toBe(BRANCH);
  });

  const UNKNOWN = '00000000-0000-4000-8000-0000000000e1';

  it('GET /:id/diff returns a schema diff', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}/diff`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('GET /:id/diff → 404 for an unknown branch', async () => {
    const res = await app.request(`/api/schema/branches/${UNKNOWN}/diff`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('POST /:id/review → 400 on an invalid status', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ status: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /:id/review records an approval', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review_status: string };
    expect(body.review_status).toBe('approved');
  });

  it('GET /:id/reviews lists reviews', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}/reviews`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: unknown[] };
    expect(Array.isArray(body.reviews)).toBe(true);
  });

  it('POST /:id/preview enables, then rotates, then disables the preview', async () => {
    const enable = await app.request(`/api/schema/branches/${branchId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(enable.status).toBe(200);
    const enabled = (await enable.json()) as { preview_token: string };
    expect(typeof enabled.preview_token).toBe('string');

    const rotate = await app.request(`/api/schema/branches/${branchId}/preview/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as { preview_token: string };
    expect(rotated.preview_token).not.toBe(enabled.preview_token);

    const disable = await app.request(`/api/schema/branches/${branchId}/preview`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(disable.status).toBe(200);
  });

  it('POST /:id/preview/rotate → 400 when preview is not enabled', async () => {
    // preview was just disabled above → rotate must 400
    const res = await app.request(`/api/schema/branches/${branchId}/preview/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('POST /:id/preview → 404 for an unknown branch', async () => {
    const res = await app.request(`/api/schema/branches/${UNKNOWN}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id → 404 for an unknown branch', async () => {
    const res = await app.request(`/api/schema/branches/${UNKNOWN}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /:id closes the branch and drops its schema (runs last)', async () => {
    const res = await app.request(`/api/schema/branches/${branchId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    // Close is soft: the row is kept with status 'closed' (the schema is dropped).
    // afterAll still removes the row; the DROP SCHEMA there is an idempotent no-op.
    const detail = await app.request(`/api/schema/branches/${branchId}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { branch: { status: string } };
    expect(body.branch.status).toBe('closed');
  });
});
