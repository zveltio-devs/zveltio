/**
 * ETag Caching — Integration Tests
 *
 * Tests ETag and Cache-Control headers on the data endpoint, including
 * 304 Not Modified responses and ETag invalidation after writes.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/etag.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import { createDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COL = `test_etag_${Date.now()}`;
let db: Database;
let sessionCookie: string;
let firstEtag: string;

async function setupGodSession(): Promise<string> {
  const email = `god-etag-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'GodPass123!', name: 'ETag God' }),
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
      fields: [{ name: 'title', type: 'text' }],
    }),
  });
  expect(createRes.status).toBeOneOf([200, 202]);

  // Insert initial record
  const insertRes = await fetch(`${BASE_URL}/api/data/${COL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ title: 'Initial record' }),
  });
  expect(insertRes.status).toBe(200);
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;
  await fetch(`${BASE_URL}/api/collections/${COL}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  }).catch(() => {});
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('ETag Caching — Integration', () => {
  it('GET collection — ETag and Cache-Control headers are present', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);

    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(etag).toMatch(/^"[a-f0-9]+"$/); // quoted hex string

    const cacheControl = res.headers.get('Cache-Control');
    expect(cacheControl).toBeTruthy();
    expect(cacheControl).toContain('private');

    firstEtag = etag!;
  });

  it('GET with If-None-Match matching ETag — returns 304 with no body', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: {
        Cookie: sessionCookie,
        'If-None-Match': firstEtag,
      },
    });
    expect(res.status).toBe(304);

    // 304 should have no body
    const text = await res.text();
    expect(text).toBe('');
  });

  it('GET with wrong If-None-Match — returns 200 with body', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: {
        Cookie: sessionCookie,
        'If-None-Match': '"00000000deadbeef"',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST new record — subsequent GET returns 200 with new ETag', async () => {
    // Insert a new record to change the content
    const insertRes = await fetch(`${BASE_URL}/api/data/${COL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ title: 'New record to invalidate ETag' }),
    });
    expect(insertRes.status).toBe(200);

    // GET with old ETag — should NOT be 304, content has changed
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: {
        Cookie: sessionCookie,
        'If-None-Match': firstEtag,
      },
    });
    expect(res.status).toBe(200);

    const newEtag = res.headers.get('ETag');
    expect(newEtag).toBeTruthy();
    expect(newEtag).not.toBe(firstEtag);
  });

  it('GET with new ETag — returns 304 again', async () => {
    // Get current ETag
    const getRes = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: { Cookie: sessionCookie },
    });
    const currentEtag = getRes.headers.get('ETag')!;

    // Now use it for conditional GET
    const res = await fetch(`${BASE_URL}/api/data/${COL}`, {
      headers: {
        Cookie: sessionCookie,
        'If-None-Match': currentEtag,
      },
    });
    expect(res.status).toBe(304);
  });
});
