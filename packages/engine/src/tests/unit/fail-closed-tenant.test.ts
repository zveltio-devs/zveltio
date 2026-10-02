/**
 * applyFailClosedTenantSetting — opt-in GUC for migration 047.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { applyFailClosedTenantSetting } from '../../lib/tenancy/fail-closed-tenant.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

afterEach(() => {
  delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
});

describe('applyFailClosedTenantSetting', () => {
  it('ALTER DATABASE SET when ZVELTIO_FAIL_CLOSED_TENANT=1', async () => {
    process.env.ZVELTIO_FAIL_CLOSED_TENANT = '1';
    const db = new CannedDb();
    db.when(/current_database/i, [{ db: 'zveltio_test' }]);
    db.when(/ALTER DATABASE/i, []);
    db.when(/set_config/i, []);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await applyFailClosedTenantSetting(asDb(db));
      expect(db.executed(/fail_closed_tenant\s*=\s*'on'/i).length).toBeGreaterThan(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('ZVELTIO_FAIL_CLOSED_TENANT'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('RESET when the flag is unset', async () => {
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    const db = new CannedDb();
    db.when(/current_database/i, [{ db: 'zveltio_test' }]);
    db.when(/ALTER DATABASE/i, []);
    db.when(/set_config/i, []);
    await applyFailClosedTenantSetting(asDb(db));
    expect(db.executed(/RESET zveltio\.fail_closed_tenant/i).length).toBeGreaterThan(0);
  });

  it('refuses to boot when the flag is set and cannot be applied', async () => {
    process.env.ZVELTIO_FAIL_CLOSED_TENANT = '1';
    const db = new CannedDb();
    db.when(/current_database/i, [{ db: 'zveltio_test' }]);
    db.fail(/ALTER DATABASE/i, new Error('must be owner of database zveltio_test'));
    await expect(applyFailClosedTenantSetting(asDb(db))).rejects.toThrow('must be owner');
  });

  it('only warns when turning it off fails — the setting that stays is stricter', async () => {
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    const db = new CannedDb();
    db.fail(/current_database/i, new Error('boom'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applyFailClosedTenantSetting(asDb(db))).resolves.toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('could not apply'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
