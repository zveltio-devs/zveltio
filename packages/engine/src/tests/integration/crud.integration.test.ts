/**
 * CRUD — Integration Tests
 *
 * Tests full CRUD lifecycle via HTTP on a dynamically created collection.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/crud.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COLLECTION = `test_crud_${Date.now()}`;
let db: Database;
let sessionCookie: string;
const createdIds: string[] = [];

async function createGodUser(): Promise<{ email: string; password: string }> {
  const email = `god-crud-${Date.now()}@test.local`;
  const password = 'GodPass123!';

  // Sign up
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'CRUD God User' }),
  });

  // Promote to god
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${email}`.execute(db);

  return { email, password };
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0];
}

beforeAll(async () => {
  if (skipAll) return;

  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const { email, password } = await createGodUser();
  sessionCookie = await signIn(email, password);

  // Create test collection via API
  const res = await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'price', type: 'float' },
        { name: 'active', type: 'boolean' },
      ],
    }),
  });
  expect(res.status).toBeLessThan(300);
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;

  // Drop test collection
  await fetch(`${BASE_URL}/api/collections/${COLLECTION}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  }).catch(() => {});

  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('CRUD — Integration', () => {
  it('POST /api/data/:collection — creates 3 records', async () => {
    const records = [
      { title: 'Item A', price: 9.99, active: true },
      { title: 'Item B', price: 24.99, active: false },
      { title: 'Item C', price: 4.99, active: true },
    ];

    for (const record of records) {
      const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify(record),
      });
      // POST /api/data/:collection returns 201 Created (RESTful convention).
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty('id');
      createdIds.push(body.id);
    }

    expect(createdIds).toHaveLength(3);
  });

  it('GET /api/data/:collection — lists records with pagination', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}?limit=10&page=1`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('records');
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThanOrEqual(3);
    expect(body).toHaveProperty('pagination');
  });

  it('GET /api/data/:collection?filter — filters by price > 10', async () => {
    const filter = encodeURIComponent(JSON.stringify({ price: { gt: 10 } }));
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}?filter=${filter}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records.every((r: any) => r.price > 10)).toBe(true);
  });

  it('GET /api/data/:collection?search — full-text search', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}?search=Item+B`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records.some((r: any) => r.title?.includes('Item B'))).toBe(true);
  });

  it('GET /api/data/:collection/:id — retrieves a single record', async () => {
    const id = createdIds[0];
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}/${id}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.title).toBe('Item A');
  });

  it('PUT /api/data/:collection/:id — updates a record', async () => {
    const id = createdIds[0];
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ title: 'Item A Updated', price: 19.99 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Item A Updated');
    expect(body.price).toBe(19.99);
  });

  it('DELETE /api/data/:collection/:id — deletes a record', async () => {
    const id = createdIds[2];
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}/${id}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);

    // Verify it's gone
    const checkRes = await fetch(`${BASE_URL}/api/data/${COLLECTION}/${id}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(checkRes.status).toBe(404);
  });

  it('zv_revisions — records create/update/delete revisions', async () => {
    const revisions = await sql<{ id: string; action: string }>`
      SELECT id, action FROM zv_revisions
      WHERE collection = ${COLLECTION}
      ORDER BY created_at ASC
    `.execute(db);

    const actions = revisions.rows.map((r) => r.action);
    expect(actions).toContain('create');
    expect(actions).toContain('update');
    expect(actions).toContain('delete');
  });
});
