/**
 * Phase C — reconcileTenantRLS on real Postgres (tenant-manager.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { reconcileTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrec_${Date.now()}`;

d('tenant reconcile RLS (in-process)', () => {
  let db: Database;
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('reconcileTenantRLS applies tenant_id + policy on managed collection tables', async () => {
    const applied = await reconcileTenantRLS(db);
    expect(applied).toBeGreaterThanOrEqual(1);

    const col = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'tenant_id'
    `.execute(db);
    expect(col.rows.length).toBe(1);

    const policy = await sql<{ policyname: string }>`
      SELECT policyname FROM pg_policies
      WHERE tablename = ${tableName} AND policyname = 'tenant_isolation'
    `.execute(db);
    expect(policy.rows.length).toBe(1);
  });
});
