/**
 * Phase C — tenants routes: create → read/list/patch → usage → environments →
 * enable-rls. Drives routes/tenants.ts through the in-process app.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SLUG = `htenant${Date.now().toString().slice(-8)}`;

d('tenants lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  // A real user, because a company is now created together with its
  // administrator. This test used to pass `admin-<slug>@test.local`, which
  // matched nobody — so it created exactly the unreachable tenant the route was
  // written to prevent, and asserted 201 on it.
  let adminEmail = '';
  let cookie: string;
  let tenantId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // Sign the administrator up rather than borrowing whichever row `LIMIT 1`
    // returns. With no ORDER BY the row is arbitrary, and a database that has
    // been used has rows whose "email" is not one — the route's schema then
    // refuses the body with a 400 that looks exactly like the failure this test
    // asserts against, so the test reads as a regression in the route.
    adminEmail = `htenant-admin-${SLUG}@test.local`;
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail,
        password: 'HarnessAdmin123!',
        name: 'Tenant Admin',
      }),
    });
    if (!signUp.ok && signUp.status !== 200 && signUp.status !== 201) {
      throw new Error(`admin sign-up failed: ${signUp.status} ${await signUp.text()}`);
    }
  });

  afterAll(async () => {
    if (!db) return;
    if (tenantId) {
      await sql`DELETE FROM zv_tenants WHERE id = ${tenantId}`.execute(db).catch(() => {});
    }
  });

  it('creates a tenant (POST /)', async () => {
    const res = await app.request(
      '/api/tenants',
      json('POST', {
        slug: SLUG,
        name: 'Harness Tenant',
        admin_user_email: adminEmail,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string } };
    tenantId = body.tenant.id;
    expect(tenantId).toBeTruthy();
  });

  it('rejects a duplicate tenant slug', async () => {
    const res = await app.request(
      '/api/tenants',
      json('POST', { slug: SLUG, name: 'Dup', admin_user_email: `a@test.local` }),
    );
    expect([400, 409]).toContain(res.status);
  });

  it('lists tenants (GET /)', async () => {
    const res = await app.request('/api/tenants', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('returns the caller tenant context (GET /me)', async () => {
    const res = await app.request('/api/tenants/me', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('patches a tenant (PATCH /:id)', async () => {
    const res = await app.request(
      `/api/tenants/${tenantId}`,
      json('PATCH', { name: 'Renamed Tenant' }),
    );
    expect(res.status).toBe(200);
  });

  it('lists environments (GET /:id/environments)', async () => {
    const res = await app.request(`/api/tenants/${tenantId}/environments`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('creates an environment (POST /:id/environments)', async () => {
    const res = await app.request(
      `/api/tenants/${tenantId}/environments`,
      json('POST', { slug: 'staging', name: 'Staging' }),
    );
    expect(res.status).toBe(201);
    // A row, no schema: `tenant_<slug>_staging` held empty copies nothing read.
    expect(await res.json()).toEqual({ success: true, schema: null });
    const row = await sql<{ schema_name: string | null }>`
      SELECT schema_name FROM zv_environments WHERE tenant_id = ${tenantId} AND slug = 'staging'
    `.execute(db);
    expect(row.rows).toEqual([{ schema_name: null }]);
    const made = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${`tenant_${SLUG}_staging`}
    `.execute(db);
    expect(made.rows[0]?.n).toBe(0);
  });

  it('404s patching an unknown tenant', async () => {
    const res = await app.request(
      '/api/tenants/00000000-0000-0000-0000-000000000000',
      json('PATCH', { name: 'x' }),
    );
    expect(res.status).toBe(404);
  });
});
