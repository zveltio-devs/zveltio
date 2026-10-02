/**
 * Phase C — /api/schema/branches (routes/schema-branches.ts + DDLManager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

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

  // `changes` is a jsonb ARRAY column. A prior write used a bare
  // `JSON.stringify(...)` parameter instead of the repo's `toJsonb()` helper,
  // which double-encodes it: the column holds a jsonb STRING whose text is
  // the array's JSON, not the array itself. `for (const change of changes)`
  // then silently iterates individual characters, applying nothing and
  // recording no error — merge reports "0 changes, 0 errors" as if there had
  // been nothing to do.
  it('POST /:id/changes stores changes as a real jsonb array, not a double-encoded string', async () => {
    const create = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `${BRANCH}-changes` }),
    });
    const created = (await create.json()) as { branch: { id: string }; schema: string };
    const id = created.branch.id;

    await app.request(`/api/schema/branches/${id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'remove_field',
        payload: { collection: 'does_not_exist', field: 'ghost' },
      }),
    });

    const raw = await sql<{ changes: unknown }>`
      SELECT changes FROM zv_schema_branches WHERE id = ${id}
    `.execute(db);
    expect(Array.isArray(raw.rows[0]?.changes)).toBe(true);

    const merge = await app.request(`/api/schema/branches/${id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    const mergeBody = (await merge.json()) as { errors: string[] };
    // The queued change targets a collection that doesn't exist, so it must
    // surface as a real error — not silently vanish as "0 changes, 0 errors".
    expect(mergeBody.errors.length).toBe(1);

    await db
      .deleteFrom('zv_schema_branches')
      .where('id', '=', id)
      .execute()
      .catch(() => {});
    await sql`DROP SCHEMA IF EXISTS ${sql.id(created.schema)} CASCADE`.execute(db).catch(() => {});
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

d('a preview token reads from the branch schema (in-process)', () => {
  const NAME = `harness-preview-${Date.now()}`;
  const COLLECTION = `hprev_${Date.now()}`;
  // A second, real tenant whose row sits in the branch table.
  const OTHER = { id: crypto.randomUUID(), slug: `hprev-other-${Date.now()}` };
  let app: Hono;
  let db: Database;
  let cookie = '';
  let member = '';
  let branchId = '';
  let schema = '';
  let token = '';
  let otherRowId = '';

  const labels = async (who: string, headers: Record<string, string> = {}) => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: who, ...headers },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ label: string }> };
    return body.records.map((r) => r.label).sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const { DDLManager } = await import('../../lib/data/index.js');
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    // What the create_collection job does right after the DDL (lib/data/ddl-queue.ts).
    const { applyTenantRLS } = await import('../../lib/tenancy/index.js');
    await applyTenantRLS(db, `zvd_${COLLECTION}`);
    ({ cookie: member } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read'] }],
    }));
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER.id}::uuid, ${OTHER.slug}, 'hprev other', 'active')`.execute(db);
    const main = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'main' }),
    });
    expect(main.status).toBe(201);
    // Provisioning is what creates the branch's copy of the table.
    const created = (await (
      await app.request('/api/schema/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ name: NAME, description: 'preview probe' }),
      })
    ).json()) as { branch: { id: string }; schema: string };
    branchId = created.branch.id;
    schema = created.schema;
    const enabled = (await (
      await app.request(`/api/schema/branches/${branchId}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: '{}',
      })
    ).json()) as { preview_token: string };
    token = enabled.preview_token;
    // Written THROUGH the preview, as a previewing client would: it lands in the branch.
    const viaPreview = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'x-preview-token': token },
      body: JSON.stringify({ label: 'branch' }),
    });
    expect(viaPreview.status).toBe(201);
    // Another tenant's row in the same branch table, planted as the owner.
    const planted = await sql<{ id: string }>`
      INSERT INTO ${sql.id(schema, `zvd_${COLLECTION}`)} (label, tenant_id)
      VALUES ('other-tenant', ${OTHER.id}::uuid) RETURNING id`.execute(db);
    otherRowId = planted.rows[0]!.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (branchId) await db.deleteFrom('zv_schema_branches').where('id', '=', branchId).execute();
    if (schema) await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
    await dropTestCollection(db, COLLECTION);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER.id}::uuid`.execute(db);
  });

  it('serves the branch row with the token and the main row without it', async () => {
    expect(typeof token).toBe('string');
    expect(await labels(cookie)).toEqual(['main']);
    expect(await labels(member, { 'x-preview-token': token })).toEqual(['branch']);
  });

  it("does not hand a previewing member another tenant's rows from the branch table", async () => {
    // The row is there — the owner sees it — so an empty answer below is the policy, not an empty table.
    const all = await sql<{ label: string }>`
      SELECT label FROM ${sql.id(schema, `zvd_${COLLECTION}`)} ORDER BY label`.execute(db);
    expect(all.rows.map((r) => r.label)).toEqual(['branch', 'other-tenant']);
    expect(await labels(member, { 'x-preview-token': token })).not.toContain('other-tenant');
    // By id the list's own `tenant_id =` shortcut is not there: only the
    // branch table's `tenant_isolation` policy stands between the two tenants.
    const byId = await app.request(`/api/data/${COLLECTION}/${otherRowId}`, {
      headers: { cookie: member, 'x-preview-token': token },
    });
    expect(byId.status).toBe(404);
  });
});
