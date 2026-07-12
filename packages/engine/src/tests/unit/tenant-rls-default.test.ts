/**
 * Regression for the zones/views/collection insert 500 ("invalid input syntax
 * for type uuid: \"\"").
 *
 * applyTenantRLS() sets the tenant_id column DEFAULT to
 *   COALESCE(current_setting('zveltio.current_tenant', true)::uuid, <default>)
 * but current_setting(..., true) returns an EMPTY STRING (not NULL) when the GUC
 * is set-but-blank — e.g. a god / single-tenant request with no tenant context.
 * COALESCE only catches NULL, so `''::uuid` blew up and EVERY insert into an RLS
 * table 500'd. The default must NULLIF the empty string first. This test pins the
 * generated DDL so the guard can't silently regress.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { applyTenantRLS } from '../../lib/tenancy/tenant-manager.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('applyTenantRLS — tenant_id default', () => {
  it("wraps the tenant GUC in NULLIF(..., '') so a blank context falls back instead of crashing", async () => {
    const db = new CannedDb();
    await applyTenantRLS(db.kysely as unknown as Database, 'zvd_demo');

    const setDefault = db.log.find((q) => /alter column tenant_id set default/i.test(q.sql));
    expect(setDefault).toBeDefined();
    // the empty-string → NULL guard must be present, before the ::uuid cast
    expect(setDefault!.sql).toMatch(
      /coalesce\(\s*nullif\(current_setting\('zveltio\.current_tenant',\s*true\),\s*''\)::uuid/i,
    );
    // and it must still fall back to the default tenant id
    expect(setDefault!.sql).toMatch(/'00000000-0000-0000-0000-000000000001'::uuid\s*\)/i);
  });

  it('refuses an unsafe table name', async () => {
    const db = new CannedDb();
    await expect(
      applyTenantRLS(db.kysely as unknown as Database, 'zvd_demo; DROP TABLE users'),
    ).rejects.toThrow(/unsafe table name/i);
  });
});
