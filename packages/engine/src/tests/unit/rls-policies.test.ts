/**
 * Application-layer RLS (lib/tenancy/rls.ts) — unit-tested over CannedDb.
 *
 * getRlsFilters' role expansion calls Casbin's getUserRoles. The enforcer is
 * initialised over an empty policy set, so the user holds no Casbin role and
 * only its direct role matches. It used to be left uninitialised and lean on a
 * `catch` that read the failed lookup as "no roles" — the fail-open that
 * rls-roles-lookup-fail-closed.test.ts now pins shut.
 * Valkey cache branches are skipped by design (getCache() is null).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  createRlsPolicy,
  deleteRlsPolicy,
  getRlsFilters,
  initPermissions,
  initRls,
  invalidateRlsCache,
  listRlsPolicies,
  updateRlsPolicy,
} from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  await initPermissions(new CannedDb().kysely as unknown as Database);
});

function setup(): CannedDb {
  const db = new CannedDb();
  initRls(db.kysely as unknown as Database);
  return db;
}

function policy(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    collection: 'contacts',
    role: '*',
    filter_field: 'owner_id',
    filter_op: 'eq',
    filter_value_source: 'user_id',
    is_enabled: true,
    ...over,
  };
}

const USER = { id: 'u-1', email: 'u1@x.com', role: 'editor' };

describe('getRlsFilters — overrides', () => {
  it('a user with the view_all permission sees every row', async () => {
    // The override is a PERMISSION now, not `user.role === 'god'`. That string
    // comparison was dead — `session.user.role` is never populated — and a
    // dead role check is exactly what nobody can audit or revoke.
    // `checkPermission` short-circuits for god users via isGodUser, so a god
    // still bypasses; the difference is that the same power can be granted to
    // a named role, or withheld from an operator who must administer without
    // reading customer data.
    const db = setup();
    db.when(/SELECT role FROM "user"/i, [{ role: 'god' }]);
    expect(await getRlsFilters('contacts', { ...USER, role: 'irrelevant' }, 'session')).toEqual([]);
  });

  it('a user WITHOUT it is filtered, whatever their session says', async () => {
    // The session role is attacker-adjacent input in the sense that it is not
    // authoritative — the database is. Claiming 'god' in the object must not
    // grant anything.
    const db = setup();
    db.when(/SELECT role FROM "user"/i, [{ role: 'member' }]);
    db.when(/FROM zvd_rls_policies/i, [policy()]);
    const filters = await getRlsFilters('contacts', { ...USER, role: 'god' }, 'session');
    expect(filters).toHaveLength(1);
    expect(filters[0]!.field).toBe('owner_id');
  });

  it('an API key bypasses only when ITS OWN flag says so', async () => {
    // Was blanket for every key, then per key with a default of true, and now
    // opt-in: migration 032 flipped the default and 040 backfilled the keys
    // issued before it.
    const db = setup();
    expect(await getRlsFilters('contacts', { ...USER, rlsBypass: true }, 'api_key')).toEqual([]);
    expect(db.log).toHaveLength(0);
  });

  it('a key with the flag OFF is filtered like anyone else', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [policy()]);
    const filters = await getRlsFilters('contacts', { ...USER, rlsBypass: false }, 'api_key');
    expect(filters).toHaveLength(1);
  });

  it('a key with NO flag at all is filtered, not exempted', async () => {
    // The case the other two miss, and the only one where `!== false` and
    // `=== true` disagree. `rlsBypass` is optional on the type, so every caller
    // that builds a user without it — a cache entry deserialised without the
    // field, a row from a query that does not select the column — used to get
    // instance-wide reads out of an omission nobody wrote down.
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [policy()]);
    const { rlsBypass: _omitted, ...noFlag } = { ...USER, rlsBypass: undefined };
    const filters = await getRlsFilters('contacts', noFlag, 'api_key');
    expect(filters).toHaveLength(1);
  });

  it('no matching policies → no restriction', async () => {
    const db = setup();
    expect(await getRlsFilters('contacts', USER, 'session')).toEqual([]);
    // the policy query includes the wildcard-collection arm
    expect(db.executed(/FROM zvd_rls_policies/i)[0]!.parameters).toContain('contacts');
  });
});

describe('getRlsFilters — policy matching', () => {
  it('wildcard-role policy applies and resolves user_id', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [policy()]);
    const filters = await getRlsFilters('contacts', USER, 'session');
    expect(filters).toEqual([{ field: 'owner_id', condition: { op: 'eq', value: 'u-1' } }]);
  });

  it('role-specific policy applies only to that role (direct-role fallback)', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [
      policy({ id: 'p-editor', role: 'editor', filter_value_source: 'user_email' }),
      policy({ id: 'p-viewer', role: 'viewer', filter_field: 'public' }),
    ]);
    const filters = await getRlsFilters('contacts', USER, 'session');
    expect(filters).toHaveLength(1);
    expect(filters[0]).toEqual({
      field: 'owner_id',
      condition: { op: 'eq', value: 'u1@x.com' },
    });
  });

  it('resolves user_role and static: sources; an absent email matches nothing; an unknown source hides everything', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [
      policy({ id: 'p-role', filter_field: 'team', filter_value_source: 'user_role' }),
      policy({ id: 'p-static', filter_field: 'region', filter_value_source: 'static:eu' }),
      policy({ id: 'p-unknown', filter_field: 'x', filter_value_source: 'nonsense' }),
      policy({ id: 'p-noemail', filter_field: 'y', filter_value_source: 'user_email' }),
    ]);
    // No email: the rule still applies, against '' — it used to be dropped,
    // which showed every row to an API key and on both realtime doors.
    const noEmail = { id: 'u-2', role: 'editor' };
    const filters = await getRlsFilters('contacts', noEmail, 'session');
    expect(filters).toEqual([
      { field: 'team', condition: { op: 'eq', value: 'editor' } },
      { field: 'region', condition: { op: 'eq', value: 'eu' } },
      // Unknown source: it used to be skipped, so it hid nothing. `in []` is
      // the condition all four appliers read as "no row".
      { field: 'x', condition: { op: 'in', value: [] } },
      { field: 'y', condition: { op: 'eq', value: '' } },
    ]);
  });

  it('defaults a missing filter_op to eq and ANDs multiple matches', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [
      policy({ id: 'a', filter_op: '' }),
      policy({
        id: 'b',
        filter_field: 'dept',
        filter_value_source: 'static:sales',
        filter_op: 'neq',
      }),
    ]);
    const filters = await getRlsFilters('contacts', USER, 'session');
    expect(filters).toEqual([
      { field: 'owner_id', condition: { op: 'eq', value: 'u-1' } },
      { field: 'dept', condition: { op: 'neq', value: 'sales' } },
    ]);
  });
});

describe('RLS policy CRUD', () => {
  it('listRlsPolicies returns all rows ordered', async () => {
    const db = setup();
    db.when(/SELECT[\s\S]*FROM zvd_rls_policies[\s\S]*ORDER BY collection, role/i, [
      policy(),
      policy({ id: 'p2' }),
    ]);
    expect(await listRlsPolicies()).toHaveLength(2);
  });

  it('createRlsPolicy inserts with defaults and returns the row', async () => {
    const db = setup();
    db.when(/INSERT INTO zvd_rls_policies/i, [policy()]);
    const created = await createRlsPolicy({
      collection: 'contacts',
      role: '*',
      filter_field: 'owner_id',
      filter_op: 'eq',
      filter_value_source: 'user_id',
    });
    expect(created.id).toBe('p1');
    const q = db.executed(/INSERT INTO zvd_rls_policies/i)[0]!;
    expect(q.parameters).toContain(true); // is_enabled default
    expect(q.parameters).toContain(null); // description default
  });

  it('updateRlsPolicy COALESCEs partial updates and returns null on miss', async () => {
    const db = setup();
    db.when(/UPDATE zvd_rls_policies/i, (q) =>
      q.parameters.includes('p1') ? [policy({ role: 'viewer' })] : [],
    );
    const updated = await updateRlsPolicy('p1', { role: 'viewer' });
    expect(updated?.role).toBe('viewer');
    expect(await updateRlsPolicy('missing', { role: 'x' })).toBeNull();
  });

  it('deleteRlsPolicy reports whether a row was removed', async () => {
    const db = setup();
    db.when(/DELETE FROM zvd_rls_policies/i, (q) =>
      q.parameters[0] === 'p1' ? [{ collection: 'contacts' }] : [],
    );
    expect(await deleteRlsPolicy('p1')).toBe(true);
    expect(await deleteRlsPolicy('ghost')).toBe(false);
  });

  it('invalidateRlsCache is a no-op without a cache backend', async () => {
    await expect(invalidateRlsCache('contacts')).resolves.toBeUndefined();
  });
});

describe('a caller without a role', () => {
  /**
   * Better-Auth does not populate `role` on a session, so this is the ordinary
   * shape of a caller, not an edge case. The engine's own routes cast the
   * session user into a type that claims `role: string` and hand it straight in.
   *
   * What must NOT happen: the policy being skipped. `resolveValue` returning
   * null means "cannot resolve", and the caller drops that policy — fail-open on
   * the one source that is absent on every session. The Postgres twin of the
   * same policy (`buildRowRulePredicate`) compares against
   * `current_setting('zveltio.user_role')`, which is `''` when unset, and keeps
   * the rule. The two must agree.
   */
  it('still gets a user_role policy, compared against the empty string', async () => {
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [
      policy({ id: 'p-role', filter_field: 'team', filter_value_source: 'user_role' }),
    ]);
    const noRole = { id: 'u-3' } as { id: string; role?: string };
    const filters = await getRlsFilters('contacts', noRole, 'session');
    expect(filters).toEqual([{ field: 'team', condition: { op: 'eq', value: '' } }]);
  });
});
