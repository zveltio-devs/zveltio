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
});
