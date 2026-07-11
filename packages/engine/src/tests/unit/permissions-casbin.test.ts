/**
 * RBAC/permissions engine (lib/tenancy/permissions.ts) — real Casbin over
 * CannedDb. initPermissions loads its policies through the Kysely adapter, so
 * canned zvd_permissions rows seed a REAL enforcer; checkPermission then
 * exercises the domain-wildcard matcher exactly as production does.
 * Valkey cache branches are skipped by design (getCache() is null).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getEnforcer,
  getUserRoles,
  initPermissions,
  invalidateGodCache,
  invalidateUserPermCache,
  isGodUser,
  listAllRoles,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

// ptype rows exactly as migration 008/009 shape them: p = sub,dom,obj,act; g = user,role,dom
const POLICY_ROWS = [
  { ptype: 'p', v0: 'editor', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
  { ptype: 'p', v0: 'editor', v1: '*', v2: 'contacts', v3: 'write', v4: null, v5: null },
  { ptype: 'p', v0: 'admin', v1: '*', v2: '*', v3: '*', v4: null, v5: null },
  { ptype: 'p', v0: 'auditor', v1: 'tenant-b', v2: 'reports', v3: 'read', v4: null, v5: null },
  { ptype: 'g', v0: 'u-editor', v1: 'editor', v2: '*', v3: null, v4: null, v5: null },
  { ptype: 'g', v0: 'u-admin', v1: 'admin', v2: '*', v3: null, v4: null, v5: null },
  { ptype: 'g', v0: 'u-auditor', v1: 'auditor', v2: 'tenant-b', v3: null, v4: null, v5: null },
];

let db: CannedDb;

function seedDb(): CannedDb {
  const canned = new CannedDb();
  canned.when(/FROM zvd_permissions/i, POLICY_ROWS);
  canned.when(/SELECT role FROM "user" WHERE id = /i, (q) => [
    { role: q.parameters[0] === 'u-god' ? 'god' : 'member' },
  ]);
  return canned;
}

beforeAll(async () => {
  // initPermissions fails closed without it; leave it set for the rest of the
  // process — no other unit suite depends on it being absent.
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  db = seedDb();
  await initPermissions(db.kysely as unknown as Database);
});

afterAll(async () => {
  // Leave a freshly seeded enforcer behind for any later suite in the process.
  await initPermissions(seedDb().kysely as unknown as Database);
});

describe('initPermissions', () => {
  it('fails closed when BETTER_AUTH_SECRET is missing', async () => {
    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await expect(initPermissions(seedDb().kysely as unknown as Database)).rejects.toThrow(
        'BETTER_AUTH_SECRET',
      );
    } finally {
      process.env.BETTER_AUTH_SECRET = saved;
      await initPermissions(seedDb().kysely as unknown as Database);
    }
  });

  it('loads the policy rows through the Kysely adapter', async () => {
    const e = await getEnforcer();
    expect(await e.getPolicy()).toHaveLength(4);
  });
});

describe('checkPermission (real Casbin matcher)', () => {
  it('grants via role inheritance and the * domain/object wildcards', async () => {
    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
    expect(await checkPermission('u-editor', 'contacts', 'write')).toBe(true);
    expect(await checkPermission('u-admin', 'anything', 'delete')).toBe(true);
  });

  it('denies actions and resources outside the granted policies', async () => {
    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
    expect(await checkPermission('u-editor', 'invoices', 'read')).toBe(false);
    expect(await checkPermission('u-nobody', 'contacts', 'read')).toBe(false);
  });

  it('hardcoded god bypass wins even with zero matching policies', async () => {
    expect(await checkPermission('u-god', 'anything', 'everything')).toBe(true);
  });

  it('scopes tenant-domain policies to their tenant', async () => {
    await runWithDomain('tenant-b', async () => {
      expect(await checkPermission('u-auditor', 'reports', 'read')).toBe(true);
    });
    await runWithDomain('tenant-a', async () => {
      expect(await checkPermission('u-auditor', 'reports', 'read')).toBe(false);
    });
    // default domain (no request context) — tenant-b grant does not apply
    expect(await checkPermission('u-auditor', 'reports', 'read')).toBe(false);
  });
});

describe('isGodUser', () => {
  it('reflects the user row role and fails closed on DB errors', async () => {
    expect(await isGodUser('u-god')).toBe(true);
    expect(await isGodUser('u-editor')).toBe(false);

    const broken = seedDb();
    broken.fail(/SELECT role FROM "user"/i, new Error('db down'));
    await initPermissions(broken.kysely as unknown as Database);
    try {
      expect(await isGodUser('u-god')).toBe(false); // fail closed
    } finally {
      await initPermissions(seedDb().kysely as unknown as Database);
    }
  });
});

describe('roles', () => {
  it('getUserRoles honours the * domain grants', async () => {
    expect(await getUserRoles('u-editor')).toEqual(['editor']);
    expect(await getUserRoles('u-nobody')).toEqual([]);
  });

  it('getUserRoles scopes tenant-domain grants', async () => {
    await runWithDomain('tenant-b', async () => {
      expect(await getUserRoles('u-auditor')).toEqual(['auditor']);
    });
    await runWithDomain('tenant-a', async () => {
      expect(await getUserRoles('u-auditor')).toEqual([]);
    });
  });

  it('listAllRoles returns the distinct role set from g policies', async () => {
    const roles = await listAllRoles();
    expect(roles.sort()).toEqual(['admin', 'auditor', 'editor']);
  });
});

describe('cache invalidation (no backend)', () => {
  it('invalidateGodCache and invalidateUserPermCache are no-ops without Valkey', async () => {
    await expect(invalidateGodCache('u-editor')).resolves.toBeUndefined();
    await expect(invalidateUserPermCache('u-editor')).resolves.toBeUndefined();
  });
});

describe('adapter write-through', () => {
  it('enforcer.addPolicy persists via INSERT and removePolicy via DELETE', async () => {
    const canned = seedDb();
    await initPermissions(canned.kysely as unknown as Database);
    try {
      const e = await getEnforcer();
      await e.addPolicy('viewer', '*', 'contacts', 'read');
      const insert = canned.executed(/INSERT INTO zvd_permissions/i)[0]!;
      expect(insert.parameters).toContain('viewer');

      await e.removePolicy('viewer', '*', 'contacts', 'read');
      expect(canned.executed(/DELETE FROM zvd_permissions/i)).toHaveLength(1);
    } finally {
      await initPermissions(seedDb().kysely as unknown as Database);
    }
  });

  it('removeFilteredPolicy deletes rows matching partial field values', async () => {
    const canned = seedDb();
    await initPermissions(canned.kysely as unknown as Database);
    try {
      const e = await getEnforcer();
      await e.removeFilteredPolicy('p', 'p', 0, 'editor', '*');
      const del = canned.executed(/DELETE FROM zvd_permissions/i)[0]!;
      expect(del.parameters).toContain('editor');
      expect(del.parameters).toContain('*');
    } finally {
      await initPermissions(seedDb().kysely as unknown as Database);
    }
  });

  it('savePolicy TRUNCATEs and re-inserts inside one transaction', async () => {
    const canned = seedDb();
    await initPermissions(canned.kysely as unknown as Database);
    try {
      const e = await getEnforcer();
      await e.savePolicy();
      expect(canned.executed(/TRUNCATE TABLE zvd_permissions/i)).toHaveLength(1);
      // every row round-trips: 4 p policies + 3 g role grants
      expect(canned.executed(/INSERT INTO zvd_permissions/i)).toHaveLength(7);
      const inserted = canned.executed(/INSERT INTO zvd_permissions/i).map((q) => q.parameters[0]);
      expect(inserted.filter((p) => p === 'p')).toHaveLength(4);
      expect(inserted.filter((p) => p === 'g')).toHaveLength(3);
    } finally {
      await initPermissions(seedDb().kysely as unknown as Database);
    }
  });
});
