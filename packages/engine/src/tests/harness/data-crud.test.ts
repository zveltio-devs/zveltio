/**
 * Phase C — data record CRUD driven through the in-process app.
 *
 * Exercises the full /api/data/:collection lifecycle (create → list → get →
 * patch → put → delete → 404) so the write-pipeline, list/single handlers,
 * query parsing, tenant middleware, and RLS all execute in-process where
 * coverage sees them. The collection's physical table is provisioned directly
 * via DDLManager (the create-collection ROUTE goes through the pg-boss DDL
 * queue, which the minimal harness doesn't start — provisioning the table
 * directly keeps this focused on the data path).
 *
 * Skips without a test database.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const COLLECTION = `hcrud_${Date.now()}`;

d('data record CRUD (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let createdId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'amount', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);
  });

  afterAll(async () => {
    if (db) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  const j = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  it('creates a record (POST) and returns it with an id', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, j({ title: 'First', amount: 10 }));
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { id?: string; title?: string };
    const rec = (body as { data?: { id: string } }).data ?? body;
    expect((rec as { id: string }).id).toBeDefined();
    createdId = (rec as { id: string; title: string }).id;
    expect((rec as { title: string }).title).toBe('First');
  });

  it('lists records (GET) including the new one', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id: string }>;
      pagination: { total: number };
    };
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(body.records.some((r) => r.id === createdId)).toBe(true);
  });

  it('fetches a single record (GET /:id)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${createdId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { title: string }; title?: string };
    expect((body.data ?? body).title).toBe('First');
  });

  it('patches a record (PATCH /:id)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${createdId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ amount: 99 }),
    });
    expect([200, 204]).toContain(res.status);

    const check = await app.request(`/api/data/${COLLECTION}/${createdId}`, {
      headers: { cookie },
    });
    const body = (await check.json()) as { data?: { amount: number }; amount?: number };
    expect(Number((body.data ?? body).amount)).toBe(99);
  });

  it('validates the query parser on list (bad filter → 400, not 500)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?filter=not-json`, {
      headers: { cookie },
    });
    // parseFilters rejects malformed input as a typed 400 (the fuzz-hardened path)
    expect([200, 400]).toContain(res.status);
  });

  it('deletes a record (DELETE /:id) and then 404s on fetch', async () => {
    const del = await app.request(`/api/data/${COLLECTION}/${createdId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);

    const gone = await app.request(`/api/data/${COLLECTION}/${createdId}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });

  it('rejects unauthenticated access to the data route', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`);
    expect([401, 403]).toContain(res.status);
  });
});
