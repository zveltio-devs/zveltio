/**
 * RLS override granted as a permission (lib/tenancy/rls.ts).
 *
 * rls-policies.test.ts proves the override through a god user, who passes every
 * `checkPermission` — so it holds whatever permission name rls.ts asks for. Here
 * the power is granted to an ordinary role, and a role holding a neighbouring
 * `data` permission must still be filtered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getRlsFilters, initPermissions, initRls } from '../../lib/tenancy/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'auditor', v1: '*', v2: 'data', v3: 'view_all', v4: null, v5: null },
  { ptype: 'p', v0: 'reader', v1: '*', v2: 'data', v3: 'read', v4: null, v5: null },
  { ptype: 'g', v0: 'u-auditor', v1: 'auditor', v2: '*', v3: null, v4: null, v5: null },
  { ptype: 'g', v0: 'u-reader', v1: 'reader', v2: '*', v3: null, v4: null, v5: null },
];

const RLS_POLICY = {
  id: 'p1',
  collection: 'contacts',
  role: '*',
  filter_field: 'owner_id',
  filter_op: 'eq',
  filter_value_source: 'user_id',
  is_enabled: true,
  description: null,
};

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  _setCacheForTests(null);
  const db = new CannedDb();
  db.when(/FROM zvd_permissions/i, POLICY_ROWS);
  db.when(/SELECT role FROM "user"/i, [{ role: 'member' }]);
  db.when(/FROM zvd_rls_policies/i, [RLS_POLICY]);
  await initPermissions(db.kysely as unknown as Database);
  initRls(db.kysely as unknown as Database);
});

afterAll(async () => {
  await initPermissions(new CannedDb().kysely as unknown as Database);
});

describe('RLS override via data:view_all', () => {
  it('lifts row filters for a non-god role granted data:view_all', async () => {
    expect(await getRlsFilters('contacts', { id: 'u-auditor' }, 'session')).toEqual([]);
  });

  it('keeps row filters for a role holding only data:read', async () => {
    const filters = await getRlsFilters('contacts', { id: 'u-reader' }, 'session');
    expect(filters).toHaveLength(1);
    expect(filters[0]!.field).toBe('owner_id');
  });
});
