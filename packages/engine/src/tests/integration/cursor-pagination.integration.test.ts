/**
 * Cursor Pagination — Integration Tests
 *
 * Tests cursor-based and offset-based pagination on the data endpoint.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/cursor-pagination.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COL = `test_cursor_${Date.now()}`;
let db: Database;
let sessionCookie: string;

async function setupGodSession(): Promise<string> {
  const email = `god-cursor-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'GodPass123!', name: 'Cursor God' }),
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

  // Create collection
  const createRes = await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
      name: COL,
      fields: [{ name: 'title', type: 'text', required: true }],
    }),
  });
  expect(createRes.status).toBeOneOf([200, 202]);

  // Insert 25 records sequentially so created_at order is deterministic
  for (let i = 1; i <= 25; i++) {
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ title: `Record ${String(i).padStart(3, '0')}` }),
    });
    expect(res.status).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  if (skipAll || !db) return;
  await fetch(`${BASE_URL}/api/collections/${COL}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  }).catch(() => {});
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Cursor Pagination — Integration', () => {
  let cursor1: string;
  let cursor2: string;
  let page1Ids: string[];

  it('GET ?limit=10 — returns 10 records and a next_cursor', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}?limit=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(10);
    expect(typeof body.next_cursor).toBe('string');
    expect(body.next_cursor).not.toBeNull();

    cursor1 = body.next_cursor;
    page1Ids = body.records.map((r: any) => r.id);
  });

  it('GET ?cursor=<cursor1>&limit=10 — returns next 10 records with no overlap', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}?cursor=${encodeURIComponent(cursor1)}&limit=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(10);

    // No overlap with first page
    const page2Ids = body.records.map((r: any) => r.id);
    const overlap = page2Ids.filter((id: string) => page1Ids.includes(id));
    expect(overlap.length).toBe(0);

    expect(typeof body.next_cursor).toBe('string');
    cursor2 = body.next_cursor;
  });

  it('GET ?cursor=<cursor2>&limit=10 — returns remaining 5 records, next_cursor is null', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}?cursor=${encodeURIComponent(cursor2)}&limit=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(5);
    // When fewer records than limit, next_cursor should be null
    expect(body.next_cursor).toBeNull();
  });

  it('GET ?page=2&limit=10 (no cursor) — offset pagination still works', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}?page=2&limit=10`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(10);
    expect(body.pagination.page).toBe(2);

    // Page 2 should not overlap with page 1
    const page2Ids = body.records.map((r: any) => r.id);
    const overlap = page2Ids.filter((id: string) => page1Ids.includes(id));
    expect(overlap.length).toBe(0);
  });

  it('GET ?limit=25 — returns all 25 records, next_cursor is null', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}?limit=25`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBe(25);
    expect(body.next_cursor).toBeNull();
  });
});
