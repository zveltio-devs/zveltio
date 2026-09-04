/**
 * An unresolvable tenant slug must not become instance-admin.
 *
 * The chain, each link measured on 2026-09-04 before this test existed:
 *
 *   1. `resolveTenantFromRequest` returns null for an unknown `x-tenant-slug` —
 *      and `getTenantBySlug` filters `status = 'active'`, so a SUSPENDED tenant
 *      returns null too. Suspending a tenant is an ordinary administrative act.
 *   2. `tenantMiddleware` then ran the request with no tenant and no store.
 *   3. `getCurrentDomain()` answers DEFAULT_TENANT_ID when there is no store.
 *   4. `requireInstanceAdmin` read that as "we are in the root tenant" and
 *      admitted a delegated `tenant_admin`.
 *
 * Measured against `/api/admin/rls` — the route that manages the row policies,
 * so the escalation landed on the control surface for tenant isolation:
 *
 *     x-tenant-slug: <a real, non-default tenant>  ->  403
 *     x-tenant-slug: <does not exist>              ->  200
 *
 * Both halves are asserted, because either one alone would close the measured
 * path and leave the other live for any future caller that arrives without a
 * store.
 */
import { describe, expect, it, beforeAll } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp } from '../../testing/app-harness.js';
import {
  getEnforcer,
  invalidateUserPermCache,
  requireInstanceAdmin,
  runWithDomain,
  DEFAULT_TENANT_ID,
} from '../../lib/tenancy/index.js';

const URL = process.env.TEST_DATABASE_URL;
const OTHER = '00000000-0000-0000-0000-0000000000e5';

describe.skipIf(!URL)('an unresolvable tenant slug is not instance-admin', () => {
  let app: any;
  let db: any;
  let cookie = '';
  let uid = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const email = `tadmin-esc-${Date.now()}@test.local`;
    const password = 'TenantAdminEsc123!';
    await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Delegated Tenant Admin' }),
    });
    // Explicitly NOT a god: an ordinary member who was delegated tenant_admin.
    await sql`UPDATE "user" SET role='member' WHERE email=${email}`.execute(db);
    const r = await sql<{ id: string }>`SELECT id FROM "user" WHERE email=${email}`.execute(db);
    uid = r.rows[0]!.id;
    const e = await getEnforcer();
    await e.addRoleForUser(uid, 'tenant_admin', '*');
    await invalidateUserPermCache(uid);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, 'esc-other-tenant', 'Other', 'active')
              ON CONFLICT (id) DO UPDATE SET status='active'`.execute(db);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  it('refuses an x-tenant-slug that matches no active tenant', async () => {
    const real = await app.request('/api/admin/rls', {
      headers: { cookie, 'x-tenant-slug': 'esc-other-tenant' },
    });
    // The baseline the escalation was measured against: a delegated tenant admin
    // is not an instance admin inside a real tenant.
    expect(real.status).toBe(403);

    const bogus = await app.request('/api/admin/rls', {
      headers: { cookie, 'x-tenant-slug': 'no-such-tenant-anywhere' },
    });
    // Not 200. 404 is the fix's answer; anything that is not a refusal is the bug.
    expect(bogus.status).not.toBe(200);
    expect(bogus.status).toBe(404);
  }, 60_000);

  it('a suspended tenant is refused, not served without a tenant', async () => {
    await sql`UPDATE zv_tenants SET status='suspended' WHERE id=${OTHER}::uuid`.execute(db);
    try {
      const res = await app.request('/api/admin/rls', {
        headers: { cookie, 'x-tenant-slug': 'esc-other-tenant' },
      });
      expect(res.status).not.toBe(200);
    } finally {
      await sql`UPDATE zv_tenants SET status='active' WHERE id=${OTHER}::uuid`.execute(db);
    }
  }, 60_000);

  it('no tenant context is not the root tenant', async () => {
    // The second half, asserted directly: even if some future caller reaches
    // here without a store, the gate must not read that as the root tenant.
    expect(await requireInstanceAdmin(uid)).toBe(false);
    // And the ordinary paths still behave: refused in another tenant...
    expect(await runWithDomain(OTHER, () => requireInstanceAdmin(uid))).toBe(false);
    // ...and admitted in the root tenant, which is what the role means there.
    expect(await runWithDomain(DEFAULT_TENANT_ID, () => requireInstanceAdmin(uid))).toBe(true);
  }, 60_000);
});
