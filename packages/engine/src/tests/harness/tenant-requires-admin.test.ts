/**
 * A company is created together with the person who administers it, or not at all.
 *
 * `admin_user_email` was validated as an email and never as a user that exists.
 * A typo therefore produced a tenant with no membership row and no Casbin role —
 * and a 201 saying it had worked. Every route is scoped by membership, so nobody
 * could open that company to repair it; only somebody querying `zv_tenants`
 * directly would ever learn it was there.
 *
 * The route's own comment already described this as the failure to avoid, which
 * is what makes it worth a test rather than a fix: the intent was written down
 * and the code did the opposite.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

d('creating a company requires its administrator', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('refuses when no user has that email, and leaves no tenant behind', async () => {
    const slug = `ghost-${STAMP}`;
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        slug,
        name: 'Ghost Co',
        plan: 'free',
        admin_user_email: `nobody-${STAMP}@example.com`,
      }),
    });
    expect(res.status).toBe(400);

    // The load-bearing half: refusing is worthless if the row was written first.
    const left = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM zv_tenants WHERE slug = ${slug}
    `.execute(db);
    expect(left.rows[0]?.n).toBe(0);
  }, 60_000);

  it('creates the company and its membership when the user exists', async () => {
    // Sign a user up rather than borrowing whichever row `LIMIT 1` returns.
    //
    // The borrowed version passed on a clean database and failed on a used one:
    // with no ORDER BY the row is arbitrary, and some fixtures write emails that
    // are not emails — one had a space in it, so zod refused the request body
    // and the route never ran the lookup this test is about. A generic 400 that
    // looks exactly like the failure being asserted is the worst kind, because
    // it reads as a regression in the code under test.
    const email = `tenant-admin-${STAMP}-${Math.floor(Math.random() * 1e6)}@test.local`;
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'HarnessAdmin123!', name: 'Tenant Admin' }),
    });
    expect([200, 201]).toContain(signUp.status);

    const slug = `real-${STAMP}`;
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ slug, name: 'Real Co', plan: 'free', admin_user_email: email }),
    });
    expect([200, 201]).toContain(res.status);

    const members = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM zv_tenant_users u
        JOIN zv_tenants t ON t.id = u.tenant_id
       WHERE t.slug = ${slug}
    `.execute(db);
    expect(members.rows[0]?.n).toBe(1);

    await sql`DELETE FROM zv_tenants WHERE slug = ${slug}`.execute(db).catch(() => {});
  }, 60_000);
});
