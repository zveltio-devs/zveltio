/**
 * Phase C — tenants routes: create (provisions a schema) → read/list/patch →
 * usage → environments → enable-rls. Drives routes/tenants.ts through the
 * in-process app. Cleans up the provisioned schema in teardown.
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
  let schemaName = '';

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
      body: JSON.stringify({ email: adminEmail, password: 'HarnessAdmin123!', name: 'Tenant Admin' }),
    });
    if (!signUp.ok && signUp.status !== 200 && signUp.status !== 201) {
      throw new Error(`admin sign-up failed: ${signUp.status} ${await signUp.text()}`);
    }
  });

  afterAll(async () => {
    if (!db) return;
    if (schemaName && /^[a-z0-9_]+$/.test(schemaName)) {
      await sql`DROP SCHEMA IF EXISTS ${sql.raw(`"${schemaName}"`)} CASCADE`
        .execute(db)
        .catch(() => {});
    }
    if (tenantId) {
      await sql`DELETE FROM zv_tenant_environments WHERE tenant_id = ${tenantId}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_tenants WHERE id = ${tenantId}`.execute(db).catch(() => {});
    }
  });

  it('creates a tenant (POST /)', async () => {
    const res = await app.request(
      '/api/tenants',
      json('POST', {
        slug: SLUG,
        name: 'Harness Tenant',
        plan: 'free',
        admin_user_email: adminEmail,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string }; default_schema?: string };
    tenantId = body.tenant.id;
    schemaName = body.default_schema ?? '';
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
      json('PATCH', { name: 'Renamed Tenant', plan: 'pro' }),
    );
    expect(res.status).toBe(200);
  });

  it('reports usage (GET /:id/usage)', async () => {
    const res = await app.request(`/api/tenants/${tenantId}/usage`, { headers: { cookie } });
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
    expect([200, 201]).toContain(res.status);
  });

  it('404s patching an unknown tenant', async () => {
    const res = await app.request(
      '/api/tenants/00000000-0000-0000-0000-000000000000',
      json('PATCH', { name: 'x' }),
    );
    expect(res.status).toBe(404);
  });
});
