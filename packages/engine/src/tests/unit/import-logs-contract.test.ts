/**
 * contractImportLogs — the half of migration 048 only an operator can time.
 *
 * 048 expanded and deliberately did not drop, because during an upgrade an
 * engine still on the previous version serves `/api/import` and reads the
 * columns. These assertions pin the two halves of that decision: nothing
 * happens without the opt-in, and the opt-in drops exactly the five columns
 * 048 named and no others.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { contractImportLogs } from '../../lib/data/import-logs-contract.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

const ALL_FIVE = [
  { column_name: 'file_format' },
  { column_name: 'processed_rows' },
  { column_name: 'success_rows' },
  { column_name: 'error_rows' },
  { column_name: 'options' },
];

afterEach(() => {
  delete process.env.ZVELTIO_IMPORT_LOGS_CONTRACT;
});

describe('contractImportLogs', () => {
  it('does nothing without the opt-in, even with every column present', async () => {
    const db = new CannedDb();
    db.when(/information_schema/i, ALL_FIVE);
    expect(await contractImportLogs(asDb(db))).toBe(0);
    // Not merely "dropped 0" — it must not have LOOKED, so a database that
    // cannot answer is never an upgrade hazard on a deployment that opted out.
    expect(db.executed(/information_schema/i).length).toBe(0);
    expect(db.executed(/DROP COLUMN/i).length).toBe(0);
  });

  it('drops the five engine-era columns when the operator opts in', async () => {
    process.env.ZVELTIO_IMPORT_LOGS_CONTRACT = '1';
    const db = new CannedDb();
    db.when(/information_schema/i, ALL_FIVE);
    db.when(/DROP COLUMN/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await contractImportLogs(asDb(db))).toBe(5);
      for (const c of ALL_FIVE) {
        expect(db.executed(new RegExp(`DROP COLUMN IF EXISTS "${c.column_name}"`)).length).toBe(1);
      }
      // The operator asked for this; they should be told it happened, and what
      // it costs — an older engine can no longer serve /api/import.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('/api/import'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('is idempotent — a second run finds nothing and drops nothing', async () => {
    process.env.ZVELTIO_IMPORT_LOGS_CONTRACT = '1';
    const db = new CannedDb();
    db.when(/information_schema/i, []);
    expect(await contractImportLogs(asDb(db))).toBe(0);
    expect(db.executed(/DROP COLUMN/i).length).toBe(0);
  });

  it('drops only what is still there, not the whole list', async () => {
    process.env.ZVELTIO_IMPORT_LOGS_CONTRACT = '1';
    const db = new CannedDb();
    db.when(/information_schema/i, [{ column_name: 'options' }]);
    db.when(/DROP COLUMN/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await contractImportLogs(asDb(db))).toBe(1);
      expect(db.executed(/DROP COLUMN/i).length).toBe(1);
      expect(db.executed(/DROP COLUMN IF EXISTS "options"/).length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('never names a column outside the five, whatever the database returns', async () => {
    process.env.ZVELTIO_IMPORT_LOGS_CONTRACT = '1';
    const db = new CannedDb();
    // The query filters on the allowlist, so this cannot happen — but the name
    // is interpolated into DDL, so the guard is asserted rather than trusted.
    db.when(/information_schema/i, [{ column_name: 'tenant_id' }, { column_name: 'options' }]);
    db.when(/DROP COLUMN/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await contractImportLogs(asDb(db))).toBe(1);
      expect(db.executed(/tenant_id/).length).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('survives a database that cannot answer, and says so', async () => {
    process.env.ZVELTIO_IMPORT_LOGS_CONTRACT = '1';
    const db = new CannedDb();
    db.fail(/information_schema/i, new Error('relation does not exist'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await contractImportLogs(asDb(db))).toBe(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('import-logs-contract'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
