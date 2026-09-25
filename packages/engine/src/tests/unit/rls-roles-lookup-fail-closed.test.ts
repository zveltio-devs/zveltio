/**
 * A role lookup that FAILS must not read as "this caller holds no roles".
 *
 * A row rule keyed on a role restricts the holders of that role, and
 * `getRlsFilters` skips every rule whose role the caller does not hold. It
 * caught a rejected `getUserRoles` as `[]`, so a failed lookup stood down every
 * role-keyed rule and the caller read the rows those rules hide. The REST list,
 * the SSE stream, the WebSocket fan-out and `?expand=` all take this answer, and
 * all four already refuse when it rejects (rls-filters-fail-closed.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { getEnforcer, getRlsFilters, initPermissions, initRls } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  _setCacheForTests(null);
  const db = new CannedDb();
  db.when(/FROM zvd_permissions/i, [
    { ptype: 'g', v0: 'u-agent', v1: 'field_agent', v2: '*', v3: null, v4: null, v5: null },
  ]);
  db.when(/SELECT role FROM "user"/i, [{ role: 'member' }]);
  db.when(/FROM zvd_rls_policies/i, [
    {
      id: 'p1',
      collection: 'visits',
      role: 'field_agent',
      filter_field: 'owner_id',
      filter_op: 'eq',
      filter_value_source: 'user_id',
      is_enabled: true,
      description: null,
    },
  ]);
  await initPermissions(db.kysely as unknown as Database);
  initRls(db.kysely as unknown as Database);
});

afterAll(async () => {
  const empty = new CannedDb().kysely as unknown as Database;
  await initPermissions(empty);
  initRls(empty);
});

describe('a failed role lookup fails closed in getRlsFilters', () => {
  it('applies the role-keyed rule when the roles resolve (the behaviour being kept)', async () => {
    const filters = await getRlsFilters('visits', { id: 'u-agent' }, 'session');
    expect(filters).toEqual([{ field: 'owner_id', condition: { op: 'eq', value: 'u-agent' } }]);
  });

  it('rejects instead of answering "no filters" when the roles cannot be read', async () => {
    const enforcer = await getEnforcer();
    const spy = spyOn(enforcer, 'getRolesForUser').mockRejectedValue(
      new Error('role manager unavailable'),
    );
    try {
      await expect(getRlsFilters('visits', { id: 'u-agent' }, 'session')).rejects.toThrow(
        /role manager unavailable/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
