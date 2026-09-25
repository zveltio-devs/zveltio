/**
 * Granting a new resource must not open a window in which the enforcer is empty.
 *
 * `materializeDefaultGrants` runs at runtime — creating a collection, loading an
 * extension — and used to finish with `enforcer.loadPolicy()`. In casbin 5.51.1
 * that is:
 *
 *   model.clearPolicy()                  every p and g rule gone, synchronously
 *   await adapter.loadPolicy(model)      one SELECT round-trip, model still empty
 *   await buildRoleLinksInternal()       rm.clear(), then addLink per g rule,
 *                                        each one an await
 *
 * Every other request keeps running through both awaits and reads the same
 * enforcer. Two things were measured against the real enforcer and the real
 * table, with the SELECT held back by a lock on `zvd_permissions` (which is
 * what any concurrent TRUNCATE/grant transaction does to it):
 *
 *   - a permission check during the SELECT rebuilt the policy-object index from
 *     the empty model and cached it. The index is only dropped on the next
 *     policy write, so after the reload every resource name collapsed onto one
 *     cache key: a member allowed to read `contacts` was then answered `true`
 *     for `payroll` — fail-open, and it stayed that way.
 *   - a row-rule lookup during the role-link rebuild saw no roles, so a rule
 *     keyed on `tenant_member` was skipped and the member got no row filter.
 *
 * The grants it writes are plain `p` rows, so they are added to the live model
 * instead; nothing is ever cleared.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import {
  checkPermission,
  clearLocalPermissionCache,
  getEnforcer,
  materializeDefaultGrants,
} from '../../lib/tenancy/index.js';
import { getRlsFilters } from '../../lib/tenancy/rls.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';

d('materializeDefaultGrants while requests are in flight', () => {
  let db: Awaited<ReturnType<typeof getTestApp>>['db'];
  const tag = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const probeUser = `reload-probe-${tag}`;
  const reader = `reload-reader-${tag}`;
  const collection = `reload_rows_${tag}`;

  async function makeMember(id: string) {
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
      VALUES (${id}, ${id}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
    `.execute(db);
    await (await getEnforcer()).addRoleForUser(id, 'tenant_member', TENANT);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await makeMember(probeUser);
    await makeMember(reader);
    await materializeDefaultGrants(db, ['contacts']);
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source)
      VALUES (${collection}, 'tenant_member', 'owner', 'eq', 'user_id')
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${collection}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 IN (${probeUser}, ${reader}) OR v2 LIKE ${`reload_%${tag}`}`.execute(
      db,
    );
    await sql`DELETE FROM "user" WHERE id IN (${probeUser}, ${reader})`.execute(db);
    clearLocalPermissionCache();
  });

  it('a check during the grant neither sees an empty enforcer nor poisons later checks', async () => {
    const e = await getEnforcer();
    const adapter = e.getAdapter();
    const origLoad = adapter.loadPolicy;
    const rm = e.getRoleManager();
    const origClear = rm.clear.bind(rm);

    const duringLoad: boolean[] = [];
    const duringRoleRebuild: unknown[] = [];
    clearLocalPermissionCache();
    const fresh = `reload_new_${tag}`;
    // Asked before the grant, so the answer and the policy-object index are
    // cached and the grant has to drop them.
    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(reader, fresh, 'read')).toBe(false);
    });

    // A request whose turn comes while the SELECT is in flight: the SELECT is
    // held by a lock taken on its own connection, released once the request is done.
    adapter.loadPolicy = async (model) => {
      let loading: Promise<void> = Promise.resolve();
      await db.transaction().execute(async (trx) => {
        await sql`LOCK TABLE zvd_permissions IN ACCESS EXCLUSIVE MODE`.execute(trx);
        loading = origLoad.call(adapter, model);
        await runWithDomain(TENANT, async () => {
          duringLoad.push(await checkPermission(probeUser, 'contacts', 'read'));
        });
      });
      await loading;
    };
    // A request whose turn comes while role links are being rebuilt.
    rm.clear = async () => {
      await origClear();
      await runWithDomain(TENANT, async () => {
        duringRoleRebuild.push(await getRlsFilters(collection, { id: probeUser }, 'session'));
      });
    };

    try {
      const written = await materializeDefaultGrants(db, [fresh]);
      expect(written).toBe(4);
    } finally {
      adapter.loadPolicy = origLoad;
      rm.clear = origClear;
    }

    // Anything that ran concurrently saw the grants that were already there.
    for (const allowed of duringLoad) expect(allowed).toBe(true);
    for (const filters of duringRoleRebuild) {
      expect(filters).toEqual([{ field: 'owner', condition: { op: 'eq', value: probeUser } }]);
    }

    await runWithDomain(TENANT, async () => {
      // The new grant is live without a restart.
      expect(await checkPermission(reader, fresh, 'read')).toBe(true);
      // And one allowed resource does not answer for another.
      expect(await checkPermission(reader, 'contacts', 'read')).toBe(true);
      expect(await checkPermission(reader, 'payroll', 'read')).toBe(false);
      expect(await getRlsFilters(collection, { id: reader }, 'session')).toEqual([
        { field: 'owner', condition: { op: 'eq', value: reader } },
      ]);
    });
  });
});
