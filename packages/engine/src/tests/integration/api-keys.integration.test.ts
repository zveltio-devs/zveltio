/**
 * API Keys — Integration Tests
 *
 * Tests API key authentication and scope enforcement via HTTP.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/api-keys.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const COLLECTION = `test_apikeys_${Date.now()}`;
let db: Database;
let godCookie: string;
let apiKey: string;
let apiKeyId: string;

async function signUp(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'API Key God' }),
  });
  const body = await res.json();
  return body.user?.id ?? body.id;
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

  const ts = Date.now();
  const email = `apikey-god-${ts}@test.local`;
  const pass = 'TestPass123!';

  const userId = await signUp(email, pass);
  await sql`UPDATE "user" SET role = 'god' WHERE id = ${userId}`.execute(db);
  godCookie = await signIn(email, pass);

  // Create test collection
  await fetch(`${BASE_URL}/api/collections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: COLLECTION,
      fields: [{ name: 'name', type: 'text' }],
    }),
  });

  // Create API key with read-only scope on COLLECTION
  const keyRes = await fetch(`${BASE_URL}/api/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: godCookie },
    body: JSON.stringify({
      name: `Test key ${ts}`,
      scopes: [{ collection: COLLECTION, actions: ['read'] }],
    }),
  });
  expect(keyRes.status).toBe(200);
  const keyBody = await keyRes.json();
  apiKey = keyBody.key ?? keyBody.api_key ?? keyBody.token;
  apiKeyId = keyBody.id;
  expect(apiKey).toBeTruthy();
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;

  // Delete API key
  if (apiKeyId) {
    await fetch(`${BASE_URL}/api/api-keys/${apiKeyId}`, {
      method: 'DELETE',
      headers: { Cookie: godCookie },
    }).catch(() => {});
  }

  // Drop collection
  await fetch(`${BASE_URL}/api/collections/${COLLECTION}`, {
    method: 'DELETE',
    headers: { Cookie: godCookie },
  }).catch(() => {});

  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('API Keys — Integration', () => {
  it('GET with valid API key returns 200', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(res.status).toBe(200);
  });

  it('POST with read-only API key returns 403', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ name: 'Should be blocked' }),
    });
    expect(res.status).toBe(403);
  });

  it('request with invalid API key returns 401', async () => {
    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': 'invalid_key_xyz_000' },
    });
    expect(res.status).toBe(401);
  });

  it('request with revoked API key returns 401', async () => {
    // Revoke the key directly in DB
    await sql`UPDATE zvd_api_keys SET is_active = false WHERE id = ${apiKeyId}`.execute(db);

    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(res.status).toBe(401);

    // Restore for subsequent tests
    await sql`UPDATE zvd_api_keys SET is_active = true WHERE id = ${apiKeyId}`.execute(db);
  });

  it('request with expired API key returns 401', async () => {
    // Expire the key directly in DB
    await sql`
      UPDATE zvd_api_keys
      SET expires_at = NOW() - INTERVAL '1 day'
      WHERE id = ${apiKeyId}
    `.execute(db);

    const res = await fetch(`${BASE_URL}/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(res.status).toBe(401);
  });
});
