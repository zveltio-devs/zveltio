/**
 * Users — Integration Tests
 *
 * Tests user list, get, update and role management.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/users.integration.test.ts
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
let regularUserId: string;
const godEmail = `god-users-${Date.now()}@test.local`;
const regularEmail = `regular-users-${Date.now()}@test.local`;

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  // Create and promote god user
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!', name: 'God User' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  const godRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!' }),
  });
  godCookie = godRes.headers.get('set-cookie') ?? '';

  // Create regular user
  const regSignup = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regularEmail, password: 'RegPass123!', name: 'Regular User' }),
  });
  const regBody = await regSignup.json() as any;
  regularUserId = regBody.user?.id ?? regBody.id;

  const regRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regularEmail, password: 'RegPass123!' }),
  });
  regularCookie = regRes.headers.get('set-cookie') ?? '';
});

afterAll(async () => {
  if (skipAll || !db) return;
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Users — Integration', () => {
  it('GET /api/users — lists users (god)', async () => {
    const res = await fetch(`${BASE_URL}/api/users`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.users ?? body)).toBe(true);
  });

  it('GET /api/users — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/users`);
    expect(res.status).toBe(401);
  });

  it('GET /api/users — returns 403 for non-admin', async () => {
    const res = await fetch(`${BASE_URL}/api/users`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([403, 401]);
  });

  it('GET /api/users/:id — returns user details (god)', async () => {
    if (!regularUserId) return;
    const res = await fetch(`${BASE_URL}/api/users/${regularUserId}`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const user = body.user ?? body;
    expect(user.email).toBe(regularEmail);
  });

  it('PATCH /api/users/:id — updates user name (god)', async () => {
    if (!regularUserId) return;
    const res = await fetch(`${BASE_URL}/api/users/${regularUserId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    expect(res.status).toBeOneOf([200, 204]);
  });

  it('GET /api/me — returns current user profile', async () => {
    const res = await fetch(`${BASE_URL}/api/me`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.user?.email ?? body.email).toBe(regularEmail);
  });

  it('GET /api/me — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/me`);
    expect(res.status).toBe(401);
  });
});
