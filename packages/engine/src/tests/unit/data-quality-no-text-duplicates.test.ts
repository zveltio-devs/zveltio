/**
 * data-quality.ts — duplicate detector skips collections with no text-like fields.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000d001';

beforeEach(() => DDLManager.invalidateCache());
afterEach(() => {
  /* tenant manager is process-global; scans are isolated via fresh CannedDb */
});

function setupNumericOnly(collection: string): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [{ id: SCAN_ID, collection, status: 'running' }]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    {
      name: collection,
      fields: JSON.stringify([{ name: 'amount', type: 'number', required: false }]),
    },
  ]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

describe('runQualityScan — duplicate detector field filter', () => {
  it('completes without duplicate queries when only numeric fields exist', async () => {
    const db = setupNumericOnly('metrics');
    const scanId = await runQualityScan(
      db.kysely as unknown as Database,
      'metrics',
      'duplicates',
      'user-1',
    );
    expect(scanId).toBe(SCAN_ID);

    const end = await db.waitFor(/update "zv_quality_scans" set/);
    expect(end.parameters).toContain('completed');
    expect(db.executed(/similarity\(/i)).toHaveLength(0);
    expect(db.executed(/insert into "zv_quality_issues"/i)).toHaveLength(0);
  });
});
