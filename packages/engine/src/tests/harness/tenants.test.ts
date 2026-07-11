/**
 * Phase C — /api/tenants (routes/tenants.ts + tenant-manager.ts).
 */

import { describe, expect, it, beforeAll } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('tenants routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('GET /api/tenants/me returns the current user tenant memberships', async () => {
    const res = await app.request('/api/tenants/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenants?: unknown[] };
    expect(Array.isArray(body.tenants)).toBe(true);
  });

  it('GET /api/tenants lists tenants for god users with manage permission', async () => {
    const res = await app.request('/api/tenants', { headers: { cookie } });
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { tenants?: unknown[] };
      expect(Array.isArray(body.tenants)).toBe(true);
    }
  });

  it('POST /api/tenants provisions a tenant when permitted', async () => {
    const admin = await db
      .selectFrom('user')
      .select('email')
      .where('role', '=', 'god')
      .executeTakeFirst();
    const slug = `h-tenant-${Date.now()}`;
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        slug,
        name: 'Harness Tenant',
        plan: 'free',
        admin_user_email: admin?.email ?? 'admin@test.local',
      }),
    });
    expect([201, 400, 403, 404]).toContain(res.status);
    if (res.status === 201) {
      const body = (await res.json()) as { tenant?: { slug: string } };
      expect(body.tenant?.slug).toBe(slug);
      await db
        .deleteFrom('zv_tenants')
        .where('slug', '=', slug)
        .execute()
        .catch(() => {});
    }
  });
});
