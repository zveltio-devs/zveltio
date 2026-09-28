/**
 * An extension table gets the same pair of indexes a collection table gets.
 *
 * `applyTenantRLS` creates `(tenant_id)` AND `(tenant_id, created_at DESC)`.
 * `reconcileExtensionTenantRLS` created only the first, so every extension table
 * carried a policy with no index able to serve an ordered read.
 *
 * What that costs, measured on 300 000 rows with the policy applied: a filtered
 * read with `ORDER BY created_at DESC LIMIT 25` takes 46 ms and discards every
 * row in the table — at ten tenants and at a hundred alike. The planner walks
 * the `created_at` index to satisfy the ordering and throws away whatever the
 * policy excludes.
 *
 * The second case is the one that made the guard necessary: an extension table
 * is any shape its author chose, and plenty have no `created_at` at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { reconcileExtensionTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const WITH_TS = `zv_extidx_${STAMP}`;
const NO_TS = `zv_extnots_${STAMP}`;
const OWN_IDX = `zv_extown_${STAMP}`;

async function indexesOn(db: Database, table: string): Promise<string[]> {
  const r = await sql<{ indexname: string }>`
    SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ${table}
  `.execute(db);
  return r.rows.map((x) => x.indexname).sort();
}

d('extension tables get the composite index too', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS "${WITH_TS}" ` +
          '(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, created_at timestamptz DEFAULT now())',
      )
      .execute(db);
    await sql
      .raw(
        `CREATE TABLE IF NOT EXISTS "${NO_TS}" ` +
          '(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid)',
      )
      .execute(db);
    // An author's own tenant index under another name, as every engine table
    // 023-029 put under a policy has (`idx_<t>_tenant`).
    await sql
      .raw(`CREATE TABLE IF NOT EXISTS "${OWN_IDX}" (id uuid PRIMARY KEY, tenant_id uuid)`)
      .execute(db);
    await sql
      .raw(`CREATE INDEX IF NOT EXISTS "${OWN_IDX}_t" ON "${OWN_IDX}" (tenant_id)`)
      .execute(db);
    // The reconciler works from `pg_policies`, on names matching
    // `tenant_isolation_%` — it repairs tables an extension's own migration has
    // already put a policy on, and creates none itself. A probe without one is
    // simply not seen, which is what the first version of this test measured
    // without noticing: it asserted a missing index and got a missing table.
    for (const t of [WITH_TS, NO_TS, OWN_IDX]) {
      await sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`).execute(db);
      await sql.raw(`CREATE POLICY "tenant_isolation_${t}" ON "${t}" USING (true)`).execute(db);
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of [WITH_TS, NO_TS, OWN_IDX]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "${t}" CASCADE`)
        .execute(db)
        .catch(() => {});
    }
  });

  it('creates both indexes when the table has created_at', async () => {
    await reconcileExtensionTenantRLS(db);
    const idx = await indexesOn(db, WITH_TS);
    expect(idx).toContain(`idx_${WITH_TS}_tenant_id`);
    expect(idx).toContain(`idx_${WITH_TS}_tenant_created`);
  }, 60_000);

  it('creates only the single-column one when there is no created_at', async () => {
    await reconcileExtensionTenantRLS(db);
    const idx = await indexesOn(db, NO_TS);
    expect(idx).toContain(`idx_${NO_TS}_tenant_id`);
    expect(idx).not.toContain(`idx_${NO_TS}_tenant_created`);
  }, 60_000);

  it('does not duplicate a tenant index the table already has under another name', async () => {
    await reconcileExtensionTenantRLS(db);
    expect(await indexesOn(db, OWN_IDX)).not.toContain(`idx_${OWN_IDX}_tenant_id`);
    // Nor any engine table 023-029 put under a policy: each already had its
    // `idx_<t>_tenant`, and got a second, identical one from the first boot.
    const policed = [
      'zv_media_files',
      'zv_media_folders',
      'zv_media_tags',
      'zv_media_file_tags',
      'zv_revisions',
      'zv_import_logs',
      'zv_dashboards',
      'zv_flows',
      'zvd_webhooks',
      'zvd_webhook_deliveries',
      'zv_environments',
    ];
    const dup = await sql<{ table: string }>`
      SELECT c.relname AS table
        FROM pg_index x
        JOIN pg_class c ON c.oid = x.indrelid
        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
       WHERE a.attname = 'tenant_id' AND x.indnatts = 1 AND x.indpred IS NULL
         AND c.relname = ANY (${policed})
       GROUP BY c.relname HAVING COUNT(*) > 1
    `.execute(db);
    expect(dup.rows.map((r) => r.table)).toEqual([]);
  }, 60_000);
});
