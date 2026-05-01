/**
 * Settings — Integration Tests
 *
 * Tests reading and writing engine settings.
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 *
 * Run with:
 * TEST_DATABASE_URL=postgresql://... TEST_PORT=3099 bun test packages/engine/src/tests/integration/settings.integration.test.ts
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

beforeAll(async () => {
  if (skipAll) return;
  db = createDb(TEST_DB_URL!);

  const godEmail = `god-settings-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!', name: 'Settings God' }),
  });
  await sql`UPDATE "user" SET role = 'god' WHERE email = ${godEmail}`.execute(db);
  const godRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: godEmail, password: 'GodPass123!' }),
  });
  godCookie = godRes.headers.get('set-cookie') ?? '';

  const regEmail = `reg-settings-${Date.now()}@test.local`;
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: regEmail, password: 'RegPass123!', name: 'Regular' }),
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
  await db.destroy().catch(() => {});
});

describe.skipIf(skipAll)('Settings — Integration', () => {
  it('GET /api/settings — returns settings object (god)', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      headers: { Cookie: godCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof (body.settings ?? body)).toBe('object');
  });

  it('GET /api/settings — returns 401 unauthenticated', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`);
    expect(res.status).toBe(401);
  });

  it('GET /api/settings — returns 403 for non-admin', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      headers: { Cookie: regularCookie },
    });
    expect(res.status).toBeOneOf([401, 403]);
  });

  it('PATCH /api/settings — updates a setting (god)', async () => {
    const res = await fetch(`${BASE_URL}/api/settings/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: godCookie },
      body: JSON.stringify({ site_name: 'Zveltio Test' }),
    });
    expect(res.status).toBeOneOf([200, 204]);
  });

  it('GET /api/settings/public — returns public settings without auth', async () => {
    const res = await fetch(`${BASE_URL}/api/settings/public`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body).toBe('object');
  });

  it('PATCH /api/settings — rejects non-admin update', async () => {
    const res = await fetch(`${BASE_URL}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: regularCookie },
      body: JSON.stringify({ site_name: 'Hacked' }),
    });
    expect(res.status).toBeOneOf([401, 403]);
  });
});
