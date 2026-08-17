/**
 * Tenant manager boot helpers (lib/tenancy/tenant-manager.ts) — RLS role warning.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { warnIfDbRoleBypassesRls } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('warnIfDbRoleBypassesRls', () => {
  it('warns when the DB role is SUPERUSER', async () => {
    const db = new CannedDb();
    db.when(/pg_roles/i, [{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfDbRoleBypassesRls(asDb(db));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('SUPERUSER'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the DB role has BYPASSRLS', async () => {
    const db = new CannedDb();
    db.when(/pg_roles/i, [{ rolname: 'zveltio', rolsuper: false, rolbypassrls: true }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfDbRoleBypassesRls(asDb(db));
      expect(warn.mock.calls.some((c) => String(c[0]).includes('BYPASSRLS'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // The mode-aware branch, which is the whole point of the parameter. Boot used
  // to print "row-level security is BYPASSED, so tenant isolation is NOT
  // enforced" directly under a line reporting isolation ENFORCED via the
  // zveltio_rls role. Two contradictory sentences do not make an operator
  // careful; they make both easy to skip. Untested until now, which is how the
  // contradiction survived in the first place.
  it('tells a superuser under an enforcing role what is ACTUALLY exposed', async () => {
    const db = new CannedDb();
    db.when(/pg_roles/i, [{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfDbRoleBypassesRls(asDb(db), 'enforced');
      const said = warn.mock.calls.map((c) => String(c[0])).join(' ');
      // Names the real residual risk — queries that never enter a tenant
      // transaction — instead of claiming isolation is off altogether.
      expect(said).toMatch(/withTenantIsolation/);
      expect(said).not.toMatch(/isolation is NOT enforced/i);
    } finally {
      warn.mockRestore();
    }
  });

  // `native` means the connection is already a plain role, so there is nothing
  // to warn about even if this is reached.
  it('says nothing in native mode', async () => {
    const db = new CannedDb();
    db.when(/pg_roles/i, [{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await warnIfDbRoleBypassesRls(asDb(db), 'native');
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for a normal role and swallows probe errors', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ok = new CannedDb();
      ok.when(/pg_roles/i, [{ rolname: 'app', rolsuper: false, rolbypassrls: false }]);
      await warnIfDbRoleBypassesRls(asDb(ok));
      expect(warn.mock.calls).toHaveLength(0);

      const broken = new CannedDb();
      broken.fail(/pg_roles/i, new Error('permission denied'));
      await expect(warnIfDbRoleBypassesRls(asDb(broken))).resolves.toBeUndefined();
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
