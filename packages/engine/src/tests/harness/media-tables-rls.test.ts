/**
 * The four media tables are isolated by Postgres, not only by the handlers.
 *
 * `zv_media_files`, `zv_media_folders`, `zv_media_tags` and `zv_media_file_tags`
 * carried `tenant_id` but no policy, so the only thing keeping one firm out of
 * another's media was a `where tenant_id = …` in each handler. A reader that does
 * not write it — here a whitelisted RPC function, the same door any SQL an API
 * key can reach goes through — saw every firm's rows. Migration 023 puts them
 * under the policy every tenant table has.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { extensionRegistry } from '../../lib/extensions/index.js';
import { _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `mrls-${OTHER.slice(0, 8)}`;
const STAMP = `mrls-${Date.now()}`;
const FN = 'harness_media_rls_rows';

d('media tables under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  const raw: Record<string, string> = {};
  const fileIds: string[] = [];

  const call = (tenant: string) =>
    app.request(`/api/rpc/${FN}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': raw[tenant]!,
        ...(tenant === OTHER ? { 'X-Tenant-Slug': SLUG } : {}),
      },
      body: '{}',
    });

  const seen = async (tenant: string): Promise<string[]> => {
    const res = await call(tenant);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tbl: string; tenant_id: string }[] };
    return data.map((r) => `${r.tbl}:${r.tenant_id}`).sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const { userId } = await createMemberSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    for (const tenant of [ROOT, OTHER]) {
      const file = await sql<{ id: string }>`
        INSERT INTO zv_media_files (filename, original_name, mimetype, storage_path, tenant_id)
        VALUES (${STAMP}, ${STAMP}, 'text/plain', ${`harness/${STAMP}`}, ${tenant}::uuid)
        RETURNING id::text AS id`.execute(db);
      const tag = await sql<{ id: string }>`
        INSERT INTO zv_media_tags (name, tenant_id) VALUES (${STAMP}, ${tenant}::uuid)
        RETURNING id::text AS id`.execute(db);
      await sql`INSERT INTO zv_media_folders (name, tenant_id)
                VALUES (${STAMP}, ${tenant}::uuid)`.execute(db);
      await sql`INSERT INTO zv_media_file_tags (file_id, tag_id, tenant_id)
                VALUES (${file.rows[0]!.id}::uuid, ${tag.rows[0]!.id}::uuid, ${tenant}::uuid)`.execute(
        db,
      );
      fileIds.push(file.rows[0]!.id);
      raw[tenant] = generateApiKey();
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${tenant}`}, ${await hashApiKey(raw[tenant]!)}, ${raw[tenant]!.slice(0, 12)},
                ${JSON.stringify([{ collection: '$rpc', actions: ['execute'] }])}::jsonb, true,
                ${tenant}::uuid, ${userId})`.execute(db);
    }
    // No tenant predicate anywhere in it: whatever it returns, the policy chose.
    // file_tags is matched by file id so its answer does not depend on another
    // table's policy.
    const ids = fileIds.map((id) => `'${id}'::uuid`).join(',');
    await sql
      .raw(`CREATE OR REPLACE FUNCTION "${FN}"() RETURNS TABLE(tbl text, tenant_id uuid)
            LANGUAGE sql STABLE AS $$
              SELECT 'files', tenant_id FROM zv_media_files WHERE original_name = '${STAMP}'
              UNION ALL SELECT 'folders', tenant_id FROM zv_media_folders WHERE name = '${STAMP}'
              UNION ALL SELECT 'tags', tenant_id FROM zv_media_tags WHERE name = '${STAMP}'
              UNION ALL SELECT 'file_tags', tenant_id FROM zv_media_file_tags WHERE file_id IN (${ids})
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
    await sql`DELETE FROM zv_media_files WHERE original_name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_media_folders WHERE name = ${STAMP}`.execute(db);
    await sql`DELETE FROM zv_media_tags WHERE name LIKE ${`${STAMP}%`}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db);
  });

  it('a reader with no tenant filter sees only its own firm’s media rows', async () => {
    const own = (t: string) => ['file_tags', 'files', 'folders', 'tags'].map((x) => `${x}:${t}`);
    expect(await seen(OTHER)).toEqual(own(OTHER));
    expect(await seen(ROOT)).toEqual(own(ROOT));
  });

  // The purge is the one background reader. Under the policy it must still reach
  // every firm's files, which it does only because it runs once per tenant.
  it('the trash purge still reaches every firm’s files', async () => {
    const seenBy: string[] = [];
    extensionRegistry.registerTrashPurgeHandler(async (tenantDb: Database) => {
      const r = await sql<{ tenant_id: string }>`
        SELECT tenant_id::text AS tenant_id FROM zv_media_files WHERE original_name = ${STAMP}
      `.execute(tenantDb);
      seenBy.push(...r.rows.map((x) => x.tenant_id));
    });
    try {
      await _internalForTests.runTrashPurge(db);
    } finally {
      extensionRegistry.registerTrashPurgeHandler(async () => {});
    }
    expect(seenBy.sort()).toEqual([ROOT, OTHER].sort());
  });

  it('a firm cannot write a media row into another firm', async () => {
    const write = withTenantIsolation(OTHER, (trx) =>
      sql`INSERT INTO zv_media_tags (name, tenant_id) VALUES (${`${STAMP}-x`}, ${ROOT}::uuid)`.execute(
        trx,
      ),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });
});
