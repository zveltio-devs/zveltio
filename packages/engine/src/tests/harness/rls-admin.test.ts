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
        // `user_id`, not `user.id`. The dotted spelling is not a source the
        // resolvers know: it was stored, listed as enabled, and hid nothing.
        filter_value_source: 'user_id',
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

  it('PATCH refuses a rule POST would refuse, instead of storing it in two steps', async () => {
    // `created_by` is text, so the only thing wrong here is the empty list —
    // which POST refuses and PATCH used to store.
    const res = await app.request(`/api/admin/rls/${policyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ filter_op: 'not_in', filter_value_source: 'static:,' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unenforceable_rls_rule');
    const row = await sql<{ filter_op: string }>`
      SELECT filter_op FROM zvd_rls_policies WHERE id = ${policyId}::uuid
    `.execute(db);
    expect(row.rows[0]?.filter_op).toBe('eq');
  });

  it('POST refuses an empty static list on a `*` rule, which has no table to check', async () => {
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        collection: '*',
        role: 'member',
        filter_field: 'created_by',
        filter_op: 'in',
        filter_value_source: 'static: , ',
      }),
    });
    // A `*` rule stored by mistake applies to every collection in this database
    // and would fail every later suite, so it goes before the assertion can.
    if (res.status === 201) {
      const { policy } = (await res.clone().json()) as { policy: { id: string } };
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policy.id}::uuid`.execute(db);
    }
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unenforceable_rls_rule');
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
