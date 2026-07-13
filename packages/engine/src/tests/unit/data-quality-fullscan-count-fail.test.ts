/**
 * data-quality.ts — full scan treats COUNT failures as zero records scanned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000f00d';

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

describe('runQualityScan — full scan COUNT failure', () => {
  it('completes with records_scanned 0 when the table COUNT query throws', async () => {
    const fields = [{ name: 'email', type: 'email' }];
    const db = setup('contacts', fields);
    db.fail(/SELECT COUNT\(\*\)::text AS count FROM/i, new Error('permission denied'));

    await runQualityScan(db.kysely as unknown as Database, 'contacts', 'full', 'user-1');
    const end = await awaitScanEnd(db);

    expect(end.parameters).toContain('completed');
    expect(end.parameters).toContain(0);
    expect(db.executed(/insert into "zv_quality_issues"/)).toHaveLength(0);
  });
});
