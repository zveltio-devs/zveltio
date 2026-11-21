/**
 * applyFailClosedTenantSetting — the tenant fallback is closed by default
 * (DR-03, migration 123); ZVELTIO_FAIL_CLOSED_TENANT=0 opts out.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  applyFailClosedTenantSetting,
  failClosedTenantEnabled,
} from '../../lib/tenancy/fail-closed-tenant.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/**
 * A database whose stored values are `first`, then `after` once read again, and
 * whose fresh connection falls back to the default tenant when `open`.
 */
function canned(first: string[], after: string[] = [], open = false): CannedDb {
  const db = new CannedDb();
  db.when(/AS open/i, [{ open }]);
  db.when(/current_database\(\) AS db/i, [{ db: 'zveltio_test' }]);
  let reads = 0;
  db.when(/pg_db_role_setting/i, () => (reads++ === 0 ? first : after).map((v) => ({ v })));
  db.when(/ALTER DATABASE/i, []);
  return db;
}

afterEach(() => {
  delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
});

describe('failClosedTenantEnabled', () => {
  it('is on unless the variable is exactly 0', () => {
    expect(failClosedTenantEnabled({})).toBe(true);
    expect(failClosedTenantEnabled({ ZVELTIO_FAIL_CLOSED_TENANT: '' })).toBe(true);
    expect(failClosedTenantEnabled({ ZVELTIO_FAIL_CLOSED_TENANT: '1' })).toBe(true);
    expect(failClosedTenantEnabled({ ZVELTIO_FAIL_CLOSED_TENANT: 'off' })).toBe(true);
    expect(failClosedTenantEnabled({ ZVELTIO_FAIL_CLOSED_TENANT: '0' })).toBe(false);
  });
});

describe('applyFailClosedTenantSetting', () => {
  it('unset and nothing stored: writes nothing — closed is the database default', async () => {
    const db = canned([]);
    await applyFailClosedTenantSetting(asDb(db));
    expect(db.executed(/ALTER DATABASE/i)).toEqual([]);
  });

  it('unset after an opt-out: resets the stored off', async () => {
    const db = canned(['off'], []);
    await applyFailClosedTenantSetting(asDb(db));
    expect(db.executed(/RESET zveltio\.fail_closed_tenant/i).length).toBe(1);
  });

  it('refuses to boot when a stored off cannot be reset', async () => {
    const db = canned(['off']);
    db.fail(/ALTER DATABASE/i, new Error('must be owner of database zveltio_test'));
    await expect(applyFailClosedTenantSetting(asDb(db))).rejects.toThrow('must be owner');
  });

  it('a stored on that cannot be reset is left alone', async () => {
    const db = canned(['on']);
    db.fail(/ALTER DATABASE/i, new Error('must be owner of database zveltio_test'));
    await expect(applyFailClosedTenantSetting(asDb(db))).resolves.toBeUndefined();
  });

  it('refuses to boot when the login role still stores off', async () => {
    const db = canned(['off'], ['off']);
    await expect(applyFailClosedTenantSetting(asDb(db))).rejects.toThrow('login role');
  });

  it('=0 stores off and warns', async () => {
    process.env.ZVELTIO_FAIL_CLOSED_TENANT = '0';
    const db = canned([], [], true);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await applyFailClosedTenantSetting(asDb(db));
      expect(db.executed(/fail_closed_tenant\s*=\s*'off'/i).length).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('fail-open'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('=0 that cannot be applied only warns — what stays is stricter', async () => {
    process.env.ZVELTIO_FAIL_CLOSED_TENANT = '0';
    const db = canned([]);
    db.fail(/ALTER DATABASE/i, new Error('must be owner of database zveltio_test'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applyFailClosedTenantSetting(asDb(db))).resolves.toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('stays CLOSED'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
