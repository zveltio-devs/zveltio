/**
 * Regression — ddl-manager.ts tenant_id DEFAULT must tolerate an EMPTY GUC.
 *
 * A custom GUC that has been SET then RESET in a session reports '' (empty
 * string) from current_setting(name, true), NOT NULL — exactly what happens on
 * a pooled connection a background job reuses after an earlier request touched
 * `zveltio.current_tenant`. The collection-table DEFAULT was
 *   COALESCE(current_setting('zveltio.current_tenant', true)::uuid, <default>)
 * which evaluates ''::uuid → "invalid input syntax for type uuid" BEFORE
 * COALESCE can fall back. The fix wraps it in NULLIF(…, ''), matching
 * tenant-manager.applyTenantRLS. This test pins a connection (transaction),
 * forces the empty-GUC state, and asserts the insert succeeds with the default
 * tenant instead of throwing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { DDLManager } from '../../lib/data/index.js';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COL = `hddlguard_${Date.now()}`;
const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';

d('ddl tenant_id default tolerates an empty GUC (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (db)
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COL}" CASCADE`)
        .execute(db)
        .catch(() => {});
  });

  it('inserts a row when the tenant GUC is the empty string (set-then-reset on a pooled conn)', async () => {
    const tenantId = await db.transaction().execute(async (trx) => {
      // Reproduce the pooled-connection state: GUC present but empty.
      await sql`SET LOCAL zveltio.current_tenant = ''`.execute(trx);
      const r = await sql<{ tenant_id: string }>`
        INSERT INTO ${sql.raw(`"zvd_${COL}"`)} (title) VALUES ('empty-guc')
        RETURNING tenant_id::text AS tenant_id
      `.execute(trx);
      return r.rows[0]!.tenant_id;
    });
    // Fell back to the default tenant rather than throwing on ''::uuid.
    expect(tenantId).toBe(DEFAULT_TENANT);
  });

  it('still honours a real tenant GUC', async () => {
    const tid = '00000000-0000-0000-0000-0000000000ab';
    const tenantId = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('zveltio.current_tenant', ${tid}, true)`.execute(trx);
      const r = await sql<{ tenant_id: string }>`
        INSERT INTO ${sql.raw(`"zvd_${COL}"`)} (title) VALUES ('real-guc')
        RETURNING tenant_id::text AS tenant_id
      `.execute(trx);
      return r.rows[0]!.tenant_id;
    });
    expect(tenantId).toBe(tid);
  });
});
