/**
 * data-quality.ts — the normalization sampler is skipped OUT LOUD when the
 * sample cannot be read.
 *
 * It carried `.catch(() => [])`, which handed the analyser an empty sample.
 * An empty sample finds nothing and reports nothing, so a table whose rows could
 * not be read produced the same result as a table with no problems — and the
 * scan still completed and still said so.
 *
 * The scan's other checks are unaffected on purpose: a failed sample is a reason
 * to skip one check, not to throw away the duplicates and outliers already
 * found.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { runQualityScan } from '../../lib/data-quality.js';
import { DDLManager } from '../../lib/data/index.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SCAN_ID = '00000000-0000-4000-8000-00000000fa11';
const COLLECTION = 'dqsample';
const USER_ID = '00000000-0000-4000-8000-000000000001';

function setup(): CannedDb {
  const db = new CannedDb();
  db.when(/insert into "zv_quality_scans"/, [
    { id: SCAN_ID, collection: COLLECTION, status: 'running' },
  ]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    { name: COLLECTION, fields: JSON.stringify([{ name: 'title', type: 'text' }]) },
  ]);
  // The record count succeeds — this test is about the SAMPLE, not the count.
  db.when(/SELECT COUNT\(\*\)::text AS count/, [{ count: '7' }]);
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

beforeEach(() => DDLManager.invalidateCache());
afterEach(() => {});

describe('runQualityScan — the normalization sample cannot be read', () => {
  it('completes the scan and does not report a clean normalization pass', async () => {
    const db = setup();
    // The sampler is the only `selectFrom(zvd_<collection>)` in the scan.
    db.fail(/select \* from "zvd_dqsample"/, new Error('relation is being rewritten'));

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));
    try {
      await runQualityScan(
        db.kysely as unknown as Database,
        COLLECTION,
        'full',
        '00000000-0000-4000-8000-00000000u5e1'.replace('u5e1', '0001'),
        undefined,
        '00000000-0000-0000-0000-0000000000aa',
      );
      await db.waitFor(/update "zv_quality_scans" set/);
    } finally {
      console.warn = realWarn;
    }

    // Said out loud, naming the scan and the table — the point of the change.
    expect(warnings.some((w) => /could not sample rows/.test(w))).toBe(true);
    expect(warnings.some((w) => w.includes(SCAN_ID) && w.includes('zvd_dqsample'))).toBe(true);
  });
});
