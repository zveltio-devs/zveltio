/**
 * Phase C — applyTenantRLS on a real collection table (tenant-manager.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { applyTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrls_${Date.now()}`;

d('tenant apply RLS (in-process)', () => {
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

  it('applyTenantRLS enables FORCE RLS and tenant_isolation policy', async () => {
    await applyTenantRLS(db, tableName);

    const col = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'tenant_id'
    `.execute(db);
    expect(col.rows.length).toBe(1);

    const policy = await sql<{ policyname: string }>`
      SELECT policyname FROM pg_policies
      WHERE tablename = ${COLLECTION} AND policyname = 'tenant_isolation'
    `.execute(db);
    expect(policy.rows.length).toBe(1);

    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = ${tableName}
    `.execute(db);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    expect(rls.rows[0]?.relforcerowsecurity).toBe(true);
  });
});
