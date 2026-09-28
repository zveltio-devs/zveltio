/**
 * `zv_dashboards` is isolated by Postgres, not only by `/api/insights`.
 *
 * The table carries `tenant_id` and had no policy: the boundary was the
 * `where tenant_id = tenantOf(c)` each insights handler remembered. A reader
 * that does not write it — here a whitelisted RPC function, the door any SQL an
 * API key can reach goes through — saw every firm's dashboards. Migration 026
 * puts the table under the tenant policy.
 *
 * `/api/insights` runs on the pool (it opens transactions of its own), and on a
 * non-superuser database a policed table read there answers for the default
 * tenant only. So the router now takes each dashboard query into the tenant's
 * `withTenantIsolation`; the second case drives the real routes in a
 * non-default firm, and because those queries now run as `zveltio_rls` they
 * are answered by the policy even on the harness's superuser pool.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `dbrls-${OTHER.slice(0, 8)}`;
const STAMP = `dbrls_${Date.now()}`;
const FN = 'harness_dashboards_rls_rows';

d('zv_dashboards under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  const raw: Record<string, string> = {};

  const inTenant = (tenant: string, extra: Record<string, string>) => ({
    'Content-Type': 'application/json',
    ...extra,
    ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const { userId } = await createMemberSession(app, db);
    god = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zv_dashboards (name, is_public, tenant_id)
                VALUES (${`${STAMP}-seed`}, true, ${tenant}::uuid)`.execute(db);
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([{ collection: '$rpc', actions: ['execute'] }])}::jsonb, true,
                ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT tenant_id FROM zv_dashboards WHERE name LIKE '${STAMP}%'
            $$`)
      .execute(db);
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql`INSERT INTO zvd_rpc_functions (function_name, required_role, is_enabled)
              VALUES (${FN}, 'member', true)`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rpc_functions WHERE function_name = ${FN}`.execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zv_dashboards WHERE name LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s dashboards', async () => {
    for (const tenant of [OTHER, ROOT]) {
      const res = await app.request(`/api/rpc/${FN}`, {
        method: 'POST',
        headers: inTenant(tenant, { 'X-API-Key': raw[tenant]! }),
        body: '{}',
      });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { tenant_id: string }[] };
      expect(data.map((r) => r.tenant_id)).toEqual([tenant]);
    }
  });

  it('the insights routes still create, list and open a non-default firm’s dashboard', async () => {
    const create = await app.request('/api/insights/dashboards', {
      method: 'POST',
      headers: inTenant(OTHER, { cookie: god }),
      body: JSON.stringify({ name: `${STAMP}-route` }),
    });
    expect(create.status).toBe(201);
    const { dashboard } = (await create.json()) as { dashboard: { id: string; tenant_id: string } };
    expect(dashboard.tenant_id).toBe(OTHER);

    const listed = async (tenant: string) => {
      const res = await app.request('/api/insights/dashboards', {
        headers: inTenant(tenant, { cookie: god }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { dashboards: { id: string; name: string }[] };
      return body.dashboards.filter((x) => x.name.startsWith(STAMP)).map((x) => x.name);
    };
    expect((await listed(OTHER)).sort()).toEqual([`${STAMP}-route`, `${STAMP}-seed`]);
    expect(await listed(ROOT)).toEqual([`${STAMP}-seed`]);

    const open = await app.request(`/api/insights/dashboards/${dashboard.id}`, {
      headers: inTenant(OTHER, { cookie: god }),
    });
    expect(open.status).toBe(200);
    const views = await sql<{ view_count: number }>`
      SELECT view_count FROM zv_dashboards WHERE id = ${dashboard.id}::uuid`.execute(db);
    expect(views.rows[0]?.view_count).toBe(1);

    const elsewhere = await app.request(`/api/insights/dashboards/${dashboard.id}`, {
      headers: inTenant(ROOT, { cookie: god }),
    });
    expect(elsewhere.status).toBe(404);
  });

  it('a firm cannot write a dashboard into another firm', async () => {
    const write = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_dashboards (name, tenant_id)
          VALUES (${`${STAMP}-x`}, ${ROOT}::uuid)`.execute(trx),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });
});
