/**
 * `zv_revisions` and `zv_import_logs` are isolated by Postgres, not only by the
 * handlers.
 *
 * Both carry `tenant_id` and had no engine policy: `zv_import_logs` got one only
 * when `data/import` was installed, `zv_revisions` never. The boundary was the
 * `where tenant_id = …` each reader remembered — and `content/drafts` counts
 * revisions without one. A reader that does not write it — here a whitelisted
 * RPC function, the door any SQL an API key can reach goes through — saw every
 * firm's audit trail. Migration 024 puts both under the tenant policy.
 *
 * The revision writer (`afterWrite`) swallows its own failure inside a
 * savepoint, so a policy it did not satisfy would drop history silently. The
 * second case writes through the data API in a non-default tenant and checks
 * the revision landed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `rirls-${OTHER.slice(0, 8)}`;
const STAMP = `rirls_${Date.now()}`;
const FN = 'harness_revisions_import_rls_rows';

d('zv_revisions and zv_import_logs under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  const raw: Record<string, string> = {};

  const headers = (tenant: string) => ({
    'Content-Type': 'application/json',
    'X-API-Key': raw[tenant]!,
    ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
  });

  const seen = async (tenant: string): Promise<string[]> => {
    const res = await app.request(`/api/rpc/${FN}`, {
      method: 'POST',
      headers: headers(tenant),
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tbl: string; tenant_id: string }[] };
    return data.map((r) => `${r.tbl}:${r.tenant_id}`).sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const { userId } = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    // A tenant key acts on its issuer's membership there.
    await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role)
              VALUES (${OTHER}::uuid, ${userId}, 'member')`.execute(db);
    await DDLManager.createCollection(db, {
      name: STAMP,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (const tenant of [ROOT, OTHER]) {
      await sql`INSERT INTO zv_revisions (collection, record_id, action, data, tenant_id)
                VALUES (${STAMP}, ${crypto.randomUUID()}, 'create', '{}'::jsonb, ${tenant}::uuid)`.execute(
        db,
      );
      await sql`INSERT INTO zv_import_logs (collection, filename, tenant_id)
                VALUES (${STAMP}, ${STAMP}, ${tenant}::uuid)`.execute(db);
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([
                  { collection: '$rpc', actions: ['execute'] },
                  { collection: STAMP, actions: ['read', 'create'] },
                ])}::jsonb, true, ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tbl text, tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT 'revisions', tenant_id FROM zv_revisions WHERE collection = '${STAMP}'
              UNION ALL SELECT 'import_logs', tenant_id FROM zv_import_logs
               WHERE collection = '${STAMP}'
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
    await sql`DELETE FROM zv_revisions WHERE collection = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_import_logs WHERE collection = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${STAMP}" CASCADE`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_tenant_users WHERE tenant_id = ${OTHER}::uuid`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s rows', async () => {
    const own = (t: string) => [`import_logs:${t}`, `revisions:${t}`];
    expect(await seen(OTHER)).toEqual(own(OTHER));
    expect(await seen(ROOT)).toEqual(own(ROOT));
  });

  it('a write in a non-default firm still records its revision under that firm', async () => {
    const res = await app.request(`/api/data/${STAMP}`, {
      method: 'POST',
      headers: headers(OTHER),
      body: JSON.stringify({ title: 'by key in B' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data?: { id?: string }; id?: string };
    const id = body.data?.id ?? body.id;
    expect(id).toBeTruthy();
    const rev = await sql<{ tenant_id: string }>`
      SELECT tenant_id::text AS tenant_id FROM zv_revisions
       WHERE collection = ${STAMP} AND record_id = ${id!} AND action = 'create'`.execute(db);
    expect(rev.rows.map((r) => r.tenant_id)).toEqual([OTHER]);
  });

  it('a firm cannot write a revision or an import log into another firm', async () => {
    const revision = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_revisions (collection, record_id, action, data, tenant_id)
          VALUES (${STAMP}, 'x', 'create', '{}'::jsonb, ${ROOT}::uuid)`.execute(trx),
    );
    await expect(revision).rejects.toThrow(/row-level security/);
    const log = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_import_logs (collection, filename, tenant_id)
          VALUES (${STAMP}, 'x', ${ROOT}::uuid)`.execute(trx),
    );
    await expect(log).rejects.toThrow(/row-level security/);
  });
});
