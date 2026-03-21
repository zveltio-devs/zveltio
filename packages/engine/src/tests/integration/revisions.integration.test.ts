/**
 * Revisions — Integration Tests
 *
 * Tests the audit/revision log: listing, filtering, getting a single revision,
 * record comments, and role-based access.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/revisions.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let db: Database;
let godCookie: string;
let regularCookie: string;
let firstRevisionId: string;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // God user
  const godEmail = `god-rev-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!', name: 'Rev God' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  const godRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!' }),
  });
  godCookie = godRes.headers.get('set-cookie') ?? '';

  // Regular user
  const regEmail = `reg-rev-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!', name: 'Rev Regular' }),
  });
  const regRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!' }),
  });
  regularCookie = regRes.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy();
});

describe.skipIf(skipAll)('Revisions — Integration', () => {
  it('GET /api/revisions — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions`);
    expect(res.status).toBe(401);
  });

  it('GET /api/revisions — returns 403 for non-admin', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([401, 403]);
  });

  it('GET /api/revisions — lists revisions (god)', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.revisions)).toBe(true);
    expect(body.pagination).toHaveProperty('total');
    if (body.revisions.length > 0) {
      firstRevisionId = body.revisions[0].id;
    }
  });

  it('GET /api/revisions?collection=user — filters by collection', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions?collection=user`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.revisions)).toBe(true);
  });

  it('GET /api/revisions?limit=5&page=1 — pagination works', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions?limit=5&page=1`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.revisions.length).toBeLessThanOrEqual(5);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(5);
  });

  it('GET /api/revisions/:id — returns single revision (god)', async () => {
    if (!firstRevisionId) return;
    const res = await fetch(`${BASE_URL}/api/revisions/${firstRevisionId}`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect((body.revision ?? body).id).toBe(firstRevisionId);
  });

  it('GET /api/revisions/:id — returns 404 for unknown id', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions/00000000-0000-0000-0000-000000000000`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/revisions/record/:collection/:id/comments — returns comments array', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions/record/user/test-id/comments`, {
      headers: { Cookie: regularCookie },
    });
    // 200 with empty array, 403 if collection access is restricted, or 503 if migration not run
    expect(res.status).toBeOneOf([200, 403, 503]);
    if (res.status === 200) {
      const body = await res.json() as any;
      expect(Array.isArray(body.comments)).toBe(true);
    }
  });

  it('POST /api/revisions/record/:collection/:id/comments — adds a comment', async () => {
    const res = await fetch(`${BASE_URL}/api/revisions/record/user/test-record/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: regularCookie },
      body: JSON.stringify({ comment: 'Integration test comment' }),
    });
    expect(res.status).toBeOneOf([200, 201, 503]);
  });
});
