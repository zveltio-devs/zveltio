/**
 * Slow Query Logging — Integration Tests
 *
 * Tests that slow queries are logged to zv_slow_queries and retrievable
 * via GET /api/admin/slow-queries.
 * Uses SLOW_QUERY_THRESHOLD_MS=0 to treat every request as slow.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * SLOW_QUERY_THRESHOLD_MS=0 TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/slow-query.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
// Skip unless both TEST_DATABASE_URL and SLOW_QUERY_THRESHOLD_MS=0 are set.
// Without threshold=0, we cannot reliably trigger a slow-query entry.
const thresholdSet = process.env.SLOW_QUERY_THRESHOLD_MS === '0';
const skipAll = !TEST_DB_URL || !thresholdSet;

const COL = `test_slowq_${Date.now()}`;
let db: Database;
let sessionCookie: string;

async function setupGodSession(): Promise<string> {
  const email = `god-slowq-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'GodPass123!', name: 'SlowQ God' }),
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

  // Create collection used for the tracked request
  const createRes = await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
      name: COL,
      fields: [{ name: 'title', type: 'text' }],
    }),
  });
  expect(createRes.status).toBeOneOf([200, 202]);
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;
  await fetch(`${BASE_URL}/api/collections/${COL}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  }).catch(() => {});
  // Clean up slow query entries created during this test run
  await sql`DELETE FROM zv_slow_queries WHERE path LIKE ${`%${COL}%`}`.execute(db).catch(() => {});
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Slow Query Logging — Integration', () => {
  const targetPath = () => `/api/data/${COL}`;

  it('GET /api/data/:collection is logged as a slow query (threshold=0)', async () => {
    // Make a request that will be recorded by the slow-query middleware
    const dataRes = await fetch(`${BASE_URL}${targetPath()}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(dataRes.status).toBe(200);

    // Give the fire-and-forget DB insert a moment to complete
    await new Promise((r) => setTimeout(r, 300));

    // Verify via GET /api/admin/slow-queries
    const sqRes = await fetch(`${BASE_URL}/api/admin/slow-queries?limit=100&min_ms=0`, {
      headers: { Cookie: sessionCookie },
    });
    expect(sqRes.status).toBe(200);

    const body = await sqRes.json() as any;
    expect(Array.isArray(body.slow_queries)).toBe(true);

    const match = body.slow_queries.find((q: any) => q.path === targetPath());
    expect(match).toBeTruthy();
    expect(match.method).toBe('GET');
    expect(match.status_code).toBe(200);
    expect(typeof match.duration_ms).toBe('number');
  }, 10_000);

  it('slow_queries entry has expected fields', async () => {
    const sqRes = await fetch(`${BASE_URL}/api/admin/slow-queries?limit=100&min_ms=0`, {
      headers: { Cookie: sessionCookie },
    });
    const body = await sqRes.json() as any;
    const entry = body.slow_queries.find((q: any) => q.path === targetPath());
    expect(entry).toBeTruthy();
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('method');
    expect(entry).toHaveProperty('path');
    expect(entry).toHaveProperty('duration_ms');
    expect(entry).toHaveProperty('status_code');
  });

  it('GET /api/admin/slow-queries — unauthorized without session returns 401', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/slow-queries?min_ms=0`);
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/slow-queries?min_ms=999999 — returns empty array for high threshold', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/slow-queries?min_ms=999999`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.slow_queries)).toBe(true);
    expect(body.slow_queries.length).toBe(0);
  });
});
