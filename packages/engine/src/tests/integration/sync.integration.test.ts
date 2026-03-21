/**
 * Sync — Integration Tests
 *
 * Tests the SDK local-first sync endpoints: push batch operations and pull changes.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/sync.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let db: Database;
let sessionCookie: string;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  const email = `sync-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SyncPass123!', name: 'Sync User' }),
  });
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'SyncPass123!' }),
  });
  sessionCookie = res.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy();
});

describe.skipIf(skipAll)('Sync — Integration', () => {
  it('POST /api/sync/push — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/sync/pull — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collections: [], since: 0 }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/sync/push — returns 400 for invalid body', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ invalid: true }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/sync/pull — returns 400 for invalid body', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ collections: 'not-an-array', since: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/sync/push — accepts empty operations batch', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ operations: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBe(0);
  });

  it('POST /api/sync/push — returns error result for operation with missing fields', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        operations: [
          { recordId: 'r1' }, // missing collection and operation
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.results[0].status).toBe('error');
  });

  it('POST /api/sync/push — returns 400 for batch > 500 operations', async () => {
    const ops = Array.from({ length: 501 }, (_, i) => ({
      collection: 'user',
      recordId: `fake-${i}`,
      operation: 'update',
      payload: { name: 'x' },
    }));
    const res = await fetch(`${BASE_URL}/api/sync/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ operations: ops }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/sync/pull — returns changes and serverTimestamp', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        collections: ['user'],
        since: 0,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    expect(typeof body.serverTimestamp).toBe('number');
  });

  it('POST /api/sync/pull — ignores unknown collections gracefully', async () => {
    const res = await fetch(`${BASE_URL}/api/sync/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        collections: ['nonexistent_table_xyz'],
        since: 0,
      }),
    });
    // Should not crash — engine catches table-not-found errors per collection
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes.length).toBe(0);
  });

  it('POST /api/sync/pull — filters by since timestamp', async () => {
    const futureTs = Date.now() + 1_000_000_000; // far in the future → 0 results
    const res = await fetch(`${BASE_URL}/api/sync/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        collections: ['user'],
        since: futureTs,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changes.length).toBe(0);
  });
});
