/**
 * Tenant membership — HTTP integration.
 *
 * Proves the membership middleware blocks a logged-in user from pivoting to a
 * tenant they don't belong to: a user who is a member of tenant A, sending
 * `X-Tenant-Slug: <tenant B>`, gets 403. Member tenant + the default tenant
 * (no header) are allowed.
 *
 * Requires TEST_DATABASE_URL and a running engine on TEST_PORT.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_PORT = process.env.TEST_PORT || '3099';
const BASE_URL = `http://localhost:${TEST_PORT}`;
const skipAll = !TEST_DB_URL;

const TS = Date.now();
const SLUG_A = `mem-a-${TS}`;
const SLUG_B = `mem-b-${TS}`;

let db: Database;
let userId: string;
let cookie: string;
let tenantAId: string;
let tenantBId: string;

async function signUp(email: string, password: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
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
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

beforeAll(async () => {
  if (skipAll) return;
  process.env.DATABASE_URL = TEST_DB_URL!;
  const { initDatabase } = await import('../../db/index.js');
  db = await initDatabase();

  const pass = 'TestPass123!';
  userId = await signUp(`mem-${TS}@test.local`, pass, 'Member User');
  // Two real tenants (unique slugs + DB-generated ids); the user is a member of A only.
  const a = await sql<{ id: string }>`INSERT INTO zv_tenants (slug, name, status)
      VALUES (${SLUG_A}, 'Tenant A', 'active') RETURNING id::text`.execute(db);
  const b = await sql<{ id: string }>`INSERT INTO zv_tenants (slug, name, status)
      VALUES (${SLUG_B}, 'Tenant B', 'active') RETURNING id::text`.execute(db);
  tenantAId = a.rows[0]!.id;
  tenantBId = b.rows[0]!.id;
  await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
      VALUES (${tenantAId}, ${userId}, 'member') ON CONFLICT DO NOTHING`.execute(db);
  cookie = await signIn(`mem-${TS}@test.local`, pass);
}, 30_000);

afterAll(async () => {
  if (skipAll || !db) return;
  await sql`DELETE FROM zv_tenant_users WHERE user_id = ${userId}`.execute(db).catch(() => {});
  await sql`DELETE FROM zv_tenants WHERE slug IN (${SLUG_A}, ${SLUG_B})`
    .execute(db)
    .catch(() => {});
});

describe.skipIf(skipAll)('Tenant membership — HTTP pivot', () => {
  it('blocks pivot to a non-member tenant (X-Tenant-Slug: B → 403)', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, {
      headers: { Cookie: cookie, 'X-Tenant-Slug': SLUG_B },
    });
    expect(res.status).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(JSON.stringify(body)).toContain('member');
  });

  it('allows the member tenant (X-Tenant-Slug: A → not the membership 403)', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, {
      headers: { Cookie: cookie, 'X-Tenant-Slug': SLUG_A },
    });
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      expect(JSON.stringify(body)).not.toContain('not a member');
    } else {
      expect(res.status).toBeLessThan(500);
    }
  });

  it('allows the default tenant (no X-Tenant-Slug → no membership check)', async () => {
    const res = await fetch(`${BASE_URL}/api/collections`, { headers: { Cookie: cookie } });
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      expect(JSON.stringify(body)).not.toContain('not a member');
    } else {
      expect(res.status).toBeLessThan(500);
    }
  });
});
