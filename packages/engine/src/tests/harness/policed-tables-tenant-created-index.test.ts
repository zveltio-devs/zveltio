/**
 * The tables 023-029 put under a policy get their `(tenant_id, created_at DESC)`
 * index from a migration, CONCURRENTLY, not from the boot reconciler.
 *
 * Migrations run before `reconcileExtensionTenantRLS`, which builds that index
 * by name on every policed table with a `created_at`. Left to it, the build was
 * a plain CREATE INDEX at boot: writes to `zv_revisions` or
 * `zvd_webhook_deliveries` blocked for the whole build, the wait unbounded.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { rollbackMigration, runPending } from '../../db/migrations/index.js';
import { reconcileExtensionTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TABLES = [
  'zv_media_files',
  'zv_media_folders',
  'zv_media_tags',
  'zv_revisions',
  'zv_import_logs',
  'zv_dashboards',
  'zv_flows',
  'zvd_webhooks',
  'zvd_webhook_deliveries',
  'zv_environments',
];
const STAMP = `tci-${Date.now()}`;

/** Every valid `(tenant_id, created_at DESC)` index, as `table:index`. */
async function composites(db: Database): Promise<string[]> {
  const r = await sql<{ k: string }>`
    SELECT c.relname || ':' || i.relname AS k
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
     WHERE c.relname = ANY (${TABLES}) AND x.indisvalid AND NOT x.indisunique
       AND pg_get_indexdef(x.indexrelid) LIKE '%(tenant_id, created_at DESC)'
  `.execute(db);
  return r.rows.map((x) => x.k).sort();
}

d('policed engine tables: tenant/created_at index from the migration', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_media_tags WHERE name LIKE ${`${STAMP}%`}`.execute(db);
  });

  it('exists after migrating, and the reconciler adds none beside it', async () => {
    const expected = TABLES.map((t) => `${t}:idx_${t}_tenant_created`).sort();
    expect(await composites(db)).toEqual(expected);
    await reconcileExtensionTenantRLS(db);
    expect(await composites(db)).toEqual(expected);
  }, 60_000);

  it('replaces an INVALID leftover of a failed concurrent build on retry', async () => {
    expect((await rollbackMigration(db, 29)).success).toBe(true);
    // A CONCURRENTLY build that fails leaves its index behind, INVALID, under
    // the name — which `IF NOT EXISTS` alone would then skip for good.
    await sql`DROP INDEX IF EXISTS idx_zv_media_tags_tenant_created`.execute(db);
    for (const n of ['a', 'b']) {
      await sql`INSERT INTO zv_media_tags (name) VALUES (${`${STAMP}-${n}`})`.execute(db);
    }
    const failed = await sql`
      CREATE UNIQUE INDEX CONCURRENTLY idx_zv_media_tags_tenant_created ON zv_media_tags (tenant_id)
    `
      .execute(db)
      .then(
        () => false,
        () => true,
      );
    expect(failed).toBe(true);
    const leftover = await sql<{ valid: boolean }>`
      SELECT indisvalid AS valid FROM pg_index
       WHERE indexrelid = 'idx_zv_media_tags_tenant_created'::regclass`.execute(db);
    expect(leftover.rows[0]?.valid).toBe(false);

    await runPending(db);
    expect(await composites(db)).toContain('zv_media_tags:idx_zv_media_tags_tenant_created');
  }, 120_000);
});
