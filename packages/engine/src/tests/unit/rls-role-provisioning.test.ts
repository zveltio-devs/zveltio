import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { initRlsEnforcementRole } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/**
 * Provisioning of the `zveltio_rls` role used to be a single DO block, and
 * Postgres abandons a DO block at its first error. On a non-superuser install —
 * the configuration this role exists to make possible — the membership GRANT
 * fails, so the block died before reaching the table grants: measured on a real
 * install, `zveltio_rls` came out with SELECT on 11 of 378 tables and no USAGE
 * on the schema at all. Tenant requests then switched into the role and got
 * `permission denied for table zvd_accounts`, while boot reported "Tenant RLS
 * enforced".
 *
 * The steps are independent statements now. These tests hold them that way,
 * because the failure was invisible from inside the engine: every log line said
 * the mechanism was working.
 */
describe('zveltio_rls provisioning', () => {
  /** Membership is granted only when it is missing, so the boot log stays clean. */
  it('does not re-grant membership the engine already holds', async () => {
    const db = new CannedDb();
    db.when(/SELECT pg_has_role/i, [{ ok: true, super_user: false }]);
    await initRlsEnforcementRole(asDb(db));

    // The guard lives inside the SQL (`IF NOT pg_has_role(...)`), so what is
    // asserted here is that the statement is guarded at all — an unguarded
    // `GRANT zveltio_rls TO current_user` printed "permission denied" on every
    // boot of a correctly configured install.
    const grants = db.executed(/GRANT zveltio_rls TO/i);
    for (const q of grants) {
      expect(q.sql).toMatch(/IF NOT pg_has_role/i);
    }
  });

  it('still grants table privileges when the membership grant is refused', async () => {
    const db = new CannedDb();
    db.fail(/ensure_rls_member/i, new Error('permission denied to grant role "zveltio_rls"'));
    db.when(/SELECT pg_has_role/i, [{ ok: true, super_user: false }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await initRlsEnforcementRole(asDb(db));
    } finally {
      warn.mockRestore();
    }

    // The whole point: step 3 runs even though step 2 threw.
    expect(db.executed(/ensure_rls_grants/i).length).toBeGreaterThan(0);
  });

  it('skips the rest when the role itself cannot be created', async () => {
    const db = new CannedDb();
    db.fail(/ensure_rls_role/i, new Error('permission denied to create role'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    let mode: string;
    try {
      mode = await initRlsEnforcementRole(asDb(db));
    } finally {
      warn.mockRestore();
    }

    // Granting to a role that does not exist can only produce noise.
    expect(db.executed(/ensure_rls_grants/i).length).toBe(0);
    // And with no role and no way to make one, the engine must not claim
    // isolation is enforced.
    expect(mode).not.toBe('enforced');
  });
});
