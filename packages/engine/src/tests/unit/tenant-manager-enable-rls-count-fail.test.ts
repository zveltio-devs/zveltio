/**
 * tenant-manager.ts — enableRLS orphan COUNT failure is non-fatal (.catch).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { enableRLS, initTenantManager } from '../../lib/tenancy/tenant-manager.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('enableRLS — orphan count resilience', () => {
  it('still applies RLS DDL when the orphan COUNT query fails', async () => {
    const db = new CannedDb();
    initTenantManager(db.kysely as unknown as Database);
    db.fail(/COUNT\(\*\)::int AS orphan_count/i, new Error('count denied'));

    await enableRLS('zvd_orders');

    expect(db.executed(/ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES/)).toHaveLength(1);
    expect(db.executed(/CREATE POLICY tenant_isolation/)).toHaveLength(1);
  });
});
