/**
 * data-quality.ts — duplicate detection scans up to three text fields per collection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000d0de';

function setup(collection: string, fields: unknown[]): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [{ id: SCAN_ID, collection, status: 'running' }]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    { name: collection, fields: JSON.stringify(fields) },
  ]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

async function awaitScanEnd(db: CannedDb) {
  return db.waitFor(/update "zv_quality_scans" set/);
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

afterEach(() => {
  delete process.env.REQUEST_LOG_RETENTION_DAYS;
});

describe('duplicate detection — multiple text fields', () => {
  const fields = [
    { name: 'email', type: 'email' },
    { name: 'nickname', type: 'text' },
    { name: 'bio', type: 'richtext' },
    { name: 'notes', type: 'text' }, // fourth text field — never scanned (slice 0,3)
  ];

  it('reports duplicates from the second text field when the first query fails', async () => {
    const db = setup('contacts', fields);
    db.fail(/similarity\(a\."email"/, new Error('function similarity does not exist'));
    db.when(/similarity\(a\."nickname"/, [{ id1: 'a1', id2: 'a2', sim: 0.93, value1: 'alice' }]);

    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const joined = inserts[0]!.parameters.join('|');
    expect(joined).toContain('duplicate');
    expect(joined).toContain('nickname');
    expect(joined).toContain('93% similar');
    // Only the first three text-like fields are scanned (email, nickname, bio).
    expect(db.executed(/similarity\(a\."bio"/)).toHaveLength(1);
    expect(db.executed(/similarity\(a\."notes"/)).toHaveLength(0);
  });

  it('batches duplicate issues from two text fields into one insert', async () => {
    const db = setup('contacts', fields);
    db.when(/similarity\(a\."email"/, [{ id1: 'e1', id2: 'e2', sim: 0.91, value1: 'a@x.com' }]);
    db.when(/similarity\(a\."nickname"/, [{ id1: 'n1', id2: 'n2', sim: 0.92, value1: 'bob' }]);
    db.when(/similarity\(a\."bio"/, []);

    await runQualityScan(asDb(db), 'contacts', 'duplicates', 'user-1');
    await awaitScanEnd(db);

    const inserts = db.executed(/insert into "zv_quality_issues"/);
    expect(inserts).toHaveLength(1);
    const joined = inserts[0]!.parameters.join('|');
    expect(joined).toContain('email');
    expect(joined).toContain('nickname');
    expect(joined).toContain('91% similar');
    expect(joined).toContain('92% similar');
  });
});
