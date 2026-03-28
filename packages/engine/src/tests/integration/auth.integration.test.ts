/**
 * Auth — Integration Tests
 *
 * Tests the authentication flow end-to-end via HTTP.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/auth.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

let createdEmail: string;
let sessionCookie: string;

beforeAll(async () => {
  if (skipAll) return;
  createdEmail = `auth-test-${Date.now()}@test.local`;
});

afterAll(async () => {
  // No persistent cleanup needed — test user lives in test DB
});

describe.skipIf(skipAll)('Auth — Integration', () => {
  it('POST /api/auth/sign-up/email — creates a new user', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: createdEmail,
        password: 'TestPass123!',
        name: 'Auth Test User',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
    expect(body.user.email).toBe(createdEmail);
  });

  it('POST /api/auth/sign-in/email — returns session cookie', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: createdEmail,
        password: 'TestPass123!',
      }),
    });

    expect(res.status).toBe(200);

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    // Extract the session cookie
    sessionCookie = setCookie!.split(';')[0];
    expect(sessionCookie).toContain('session');
  });

  it('GET /api/me — returns user data with valid session cookie', async () => {
    const res = await fetch(`${BASE_URL}/api/me`, {
      headers: { Cookie: sessionCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('user');
    expect(body.user).toHaveProperty('email');
    expect(body.user.email).toBe(createdEmail);
  });

  it('GET /api/me — returns 401 without cookie', async () => {
    const res = await fetch(`${BASE_URL}/api/me`);
    expect(res.status).toBe(401);
  });

  it('GET /api/me — returns 401 with invalid cookie', async () => {
    const res = await fetch(`${BASE_URL}/api/me`, {
      headers: { Cookie: 'better-auth.session_token=invalid_token_xyz' },
    });
    expect(res.status).toBe(401);
  });
});
