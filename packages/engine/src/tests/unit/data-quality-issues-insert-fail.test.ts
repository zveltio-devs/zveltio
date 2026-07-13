/**
 * data-quality.ts — scan completes when zv_quality_issues INSERT fails (non-fatal).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000f001';

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

describe('runQualityScan — issues insert failure', () => {
  it('marks completed with issues_found 0 when issue rows cannot be persisted', async () => {
    const fields = [{ name: 'email', type: 'email' }];
    const db = setup('contacts', fields);
    db.when(/similarity\(a\."email"/, [{ id1: 'r1', id2: 'r2', sim: 0.92, value1: 'a@x.com' }]);
    db.fail(/insert into "zv_quality_issues"/, new Error('disk full'));

    await runQualityScan(db.kysely as unknown as Database, 'contacts', 'duplicates', 'user-1');
    const end = await awaitScanEnd(db);

    expect(end.parameters).toContain('completed');
    expect(end.parameters).toContain(0);
  });
});
