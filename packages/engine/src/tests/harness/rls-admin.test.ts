/**
 * Phase C — /api/admin/rls (routes/rls.ts + lib/tenancy/rls.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrls_${Date.now()}`;

d('admin RLS routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let policyId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('GET /api/admin/rls lists policies', async () => {
    const res = await app.request('/api/admin/rls', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policies: unknown[] };
    expect(Array.isArray(body.policies)).toBe(true);
  });

  it('POST /api/admin/rls creates a row-level policy', async () => {
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: 'member',
        filter_field: 'created_by',
        filter_op: 'eq',
        filter_value_source: 'user.id',
        description: 'harness rls',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { policy: { id: string } };
    policyId = body.policy.id;
    expect(policyId).toBeDefined();
  });

  it('PATCH /api/admin/rls/:id updates the policy', async () => {
    const res = await app.request(`/api/admin/rls/${policyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ description: 'updated harness rls' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { policy: { description: string } };
    expect(body.policy.description).toBe('updated harness rls');
  });

  it('DELETE /api/admin/rls/:id removes the policy', async () => {
    const res = await app.request(`/api/admin/rls/${policyId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    policyId = '';
  });
});
