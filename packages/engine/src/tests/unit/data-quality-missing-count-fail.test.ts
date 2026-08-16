/**
 * data-quality.ts — missing-data scan treats COUNT failures as an empty table.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000c0de';

function setup(collection: string, fields: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [{ id: SCAN_ID, collection, status: 'running' }]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    { name: collection, fields: JSON.stringify(fields) },
  ]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

async function awaitScanEnd(db: CannedDb) {
  return db.waitFor(/update "zv_quality_scans" set/);
}

beforeEach(() => DDLManager.invalidateCache());
afterEach(() => {});

describe('missing-data detection — COUNT failure', () => {
  /**
   * This asserted `completed`, and that was the defect. The COUNT was wrapped in
   * `.catch(() => ({ rows: [{ total: '0' }] }))`, and the next line returns early
   * on zero — so a table the scan could not count reported a clean bill of
   * health. The one input gating the whole missing-data detector was also the
   * one allowed to fail silently, and what it produced on failure was
   * indistinguishable from "we looked and everything is fine".
   */
  it('reports the scan as failed when the table COUNT query throws', async () => {
    const fields = [{ name: 'email', type: 'email', required: true }];
    const db = setup('contacts', fields);
    db.fail(/SELECT COUNT\(\*\)::text AS total/i, new Error('relation does not exist'));

    await runQualityScan(db.kysely as unknown as Database, 'contacts', 'missing_data', 'user-1');
    const end = await awaitScanEnd(db);

    expect(db.executed(/WITH missing/)).toHaveLength(0);
    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
    expect(end.parameters).toContain('failed');
  });
});
