/**
 * Phase C — /api/tenants (routes/tenants.ts + tenant-manager.ts).
 *
 * Every route here except `/me` is instance-level: creating a company, renaming
 * it, granting its members. The god cases assert the exact success status, and a
 * plain member is refused on each gated route. The first version accepted
 * `[200, 403]` for god and `[201, 400, 403, 404]` for a create, so deleting the
 * `requireInstanceAdmin` gate from POST /api/tenants left the whole suite green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTenantSchemaName } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('tenants routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const slug = `h-tenant-${Date.now()}`;
  let tenantId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db || !tenantId) return;
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${tenantId}::uuid`
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zv_tenants')
      .where('id', '=', tenantId)
      .execute()
      .catch(() => {});
  });

  it('GET /api/tenants/me returns the current user tenant memberships', async () => {
    const res = await app.request('/api/tenants/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenants?: unknown[] };
    expect(Array.isArray(body.tenants)).toBe(true);
  });

  it('GET /api/tenants lists tenants for a god user', async () => {
    const res = await app.request('/api/tenants', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenants?: unknown[] };
    expect(Array.isArray(body.tenants)).toBe(true);
  });

  it('POST /api/tenants provisions a tenant for a god user', async () => {
    const admin = await db
      .selectFrom('user')
      .select('email')
      .where('role', '=', 'god')
      .executeTakeFirstOrThrow();
    const res = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ slug, name: 'Harness Tenant', admin_user_email: admin.email }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tenant: { id: string; slug: string } };
    expect(body.tenant.slug).toBe(slug);
    tenantId = body.tenant.id;
    // Isolation is RLS on tenant_id and nothing reads a per-tenant or
    // per-environment schema, so none is made: the two environments are rows.
    const schemas = await sql<{ s: string }>`
      SELECT nspname AS s FROM pg_namespace WHERE nspname LIKE ${`${getTenantSchemaName(slug)}%`}
    `.execute(db);
    expect(schemas.rows).toEqual([]);
    const envs = await sql<{ slug: string; schema_name: string | null }>`
      SELECT slug, schema_name FROM zv_environments WHERE tenant_id = ${tenantId}::uuid ORDER BY 1
    `.execute(db);
    expect(envs.rows).toEqual([
      { slug: 'dev', schema_name: null },
      { slug: 'prod', schema_name: null },
    ]);
  });

  it('refuses a plain member on every instance-level route', async () => {
    expect(tenantId).not.toBe('');
    const member = await createMemberSession(app, db);
    const json = { 'Content-Type': 'application/json', cookie: member.cookie };

    // Control: the member reaches this router, so a 403 below is the route's
    // own gate and not the session or membership guard in front of it.
    expect((await app.request('/api/tenants/me', { headers: json })).status).toBe(200);

    const attempts: Array<[string, string, unknown?]> = [
      ['GET', '/api/tenants'],
      ['POST', '/api/tenants', { slug: `${slug}-x`, name: 'Nope', admin_user_email: member.email }],
      ['PATCH', `/api/tenants/${tenantId}`, { name: 'Renamed by a member' }],
      ['GET', `/api/tenants/${tenantId}/environments`],
      ['POST', `/api/tenants/${tenantId}/environments`, { slug: 'qa', name: 'QA' }],
      ['POST', `/api/tenants/${tenantId}/enable-rls/anything`],
      ['GET', `/api/tenants/${tenantId}/members`],
      ['POST', `/api/tenants/${tenantId}/members`, { user_email: member.email, role: 'owner' }],
      ['DELETE', `/api/tenants/${tenantId}/members/${member.userId}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await app.request(path, {
        method,
        headers: json,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }

    // Nothing the refused calls asked for happened.
    const state = await sql<{ name: string; extra: number; members: number }>`
      SELECT
        (SELECT name FROM zv_tenants WHERE id = ${tenantId}::uuid) AS name,
        (SELECT COUNT(*)::int FROM zv_tenants WHERE slug = ${`${slug}-x`}) AS extra,
        (SELECT COUNT(*)::int FROM zv_tenant_users
          WHERE tenant_id = ${tenantId}::uuid AND user_id = ${member.userId}) AS members
    `.execute(db);
    expect(state.rows[0]).toEqual({ name: 'Harness Tenant', extra: 0, members: 0 });
  }, 60_000);
});
