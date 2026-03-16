/**
 * Collections — Integration Tests
 *
 * Tests the full collection lifecycle: create, list, get, update, delete.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/collections.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COL = `test_col_${Date.now()}`;
let db: Database;
let sessionCookie: string;

async function setupGodSession(): Promise<string> {
  const email = `god-col-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'GodPass123!', name: 'Col God' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${email}`.execute(db);
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'GodPass123!' }),
  });
  return res.headers.get('set-cookie') ?? '';
}

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);
  sessionCookie = await setupGodSession();
});

afterAll(async () => {
  if (skipAll || !db) return;
  await sql`DROP TABLE IF EXISTS ${sql.id(COL)}`.execute(db).catch(() => {});
  await db.destroy();
});

describe.skipIf(skipAll)('Collections — Integration', () => {
  it('POST /api/collections — creates a collection (202)', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        name: COL,
        fields: [
          { name: 'title', type: 'text', required: true },
          { name: 'price', type: 'number' },
          { name: 'active', type: 'boolean', default: true },
        ],
      }),
    });
    expect(res.status).toBeOneOf([200, 202]);
    const body = await res.json() as any;
    expect(body).toHaveProperty('name');
  });

  it('GET /api/collections — lists all collections', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.collections ?? body)).toBe(true);
  });

  it('GET /api/collections/:name — returns schema for created collection', async () => {
    const res = await fetch(`${BASE_URL}/api/collections/${COL}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const col = body.collection ?? body;
    expect(col.name).toBe(COL);
    expect(Array.isArray(col.fields)).toBe(true);
  });

  it('PATCH /api/collections/:name — adds a new field', async () => {
    const res = await fetch(`${BASE_URL}/api/collections/${COL}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        fields: [{ name: 'description', type: 'richtext' }],
      }),
    });
    expect(res.status).toBeOneOf([200, 202]);
  });

  it('GET /api/collections — unauthenticated returns 401', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`);
    expect(res.status).toBe(401);
  });

  it('POST /api/collections — rejects duplicate name', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ name: COL, fields: [] }),
    });
    expect(res.status).toBeOneOf([400, 409]);
  });

  it('DELETE /api/collections/:name — removes the collection', async () => {
    const res = await fetch(`${BASE_URL}/api/collections/${COL}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBeOneOf([200, 204]);
  });

  it('GET /api/collections/:name — returns 404 after delete', async () => {
    const res = await fetch(`${BASE_URL}/api/collections/${COL}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(404);
  });
});
