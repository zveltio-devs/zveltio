/**
 * Deny by default: what is not explicitly permitted is forbidden.
 *
 * The seeded tenant roles gave `tenant_member` `('*', '*', 'read')` — and
 * create, and update. Twenty-three extensions guard their routes with
 * `permissionGate(ctx, '<resource>')`, and every one of those guards was inert:
 * the wildcard matched before the resource name was considered. An audit drove
 * it end to end — an ordinary member read a colleague's national ID, IBAN,
 * salary and home address, and could edit them.
 *
 * What makes these tests worth having is the shape of the bug. Both halves of
 * the authorization model were present and both looked right; they simply did
 * not meet. A test that only asserts "member cannot read payroll" would pass
 * against a build where authorization is broken outright, so the cases below
 * pin every corner:
 *
 *   - a member still reaches ordinary data (nothing was broken to fix this)
 *   - a member does not reach sensitive data
 *   - a member still cannot delete — the negative control from the original
 *     finding, and the proof that a passing suite is not just a dead enforcer
 *   - an owner and a tenant admin still do reach everything
 *   - an explicit grant by name works, which is how an operator opts a role in
 *   - a resource nobody granted is closed, with no registry entry needed
 *   - and a partial wildcard grants nothing, which is the rule itself
 *
 * The tenant-admin case is the one a careless fix breaks: a rule that refused
 * wildcards outright would lock administrators out of HR, which is not
 * confidentiality, it is an outage.
 *
 * The last case is the one that earns its keep. Migration 034 deleted the
 * offending rows, so every other test here would pass against the old
 * permissive matcher — they check the migration, not the rule. That one writes
 * the row back and asks what it means.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import {
  checkPermission,
  getEnforcer,
  invalidateUserPermCache,
  listSensitiveResources,
  materializeDefaultGrants,
  registerSensitiveResources,
} from '../../lib/tenancy/index.js';
import { runWithDomain } from '../../lib/tenancy/tenant-context.js';

const d = harnessAvailable() ? describe : describe.skip;

const TENANT = '00000000-0000-0000-0000-000000000001';

/** Give `userId` a tenant role in the default tenant's domain. */
async function grantRole(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  userId: string,
  role: string,
) {
  await sql`
    INSERT INTO zvd_permissions (ptype, v0, v1, v2)
    VALUES ('g', ${userId}, ${role}, ${TENANT})
  `.execute(db);
  // The enforcer holds its policies in memory; a row written behind it is
  // invisible until reloaded. Same for the per-user decision cache.
  await (await getEnforcer()).loadPolicy();
  await invalidateUserPermCache(userId);
}

/** A user row is enough — these tests exercise the policy engine, not sign-up. */
async function makeUser(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  suffix: string,
): Promise<string> {
  const id = `sens-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
    VALUES (${id}, ${suffix}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
  `.execute(db);
  return id;
}

d('sensitive resources', () => {
  it('a member keeps ordinary access', async () => {
    // First, because a fix that quietly removed everyone's access would satisfy
    // every other assertion in this file.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'member-ok');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'contacts', 'read')).toBe(true);
      expect(await checkPermission(user, 'projects', 'update')).toBe(true);
    });
  });

  it('a member does not reach payroll or employee records', async () => {
    const { db } = await getTestApp();
    const user = await makeUser(db, 'member-blocked');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'payroll', 'read')).toBe(false);
      expect(await checkPermission(user, 'employees', 'read')).toBe(false);
      expect(await checkPermission(user, 'employees', 'update')).toBe(false);
      expect(await checkPermission(user, 'banking', 'read')).toBe(false);
    });
  });

  it('the four resources widened by owner decision are closed too', async () => {
    // Migration 035. Naming them in `SENSITIVE_RESOURCES` only governs grants
    // that have yet to be created — 034 had already written these, so without
    // the revoke the list would have looked right and changed nothing on any
    // running instance. This asserts the revoke happened, not the list.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'widened');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'expenses', 'read')).toBe(false);
      expect(await checkPermission(user, 'time-tracking', 'read')).toBe(false);
      expect(await checkPermission(user, 'accounting', 'read')).toBe(false);
      expect(await checkPermission(user, 'invoices', 'read')).toBe(false);
      // Ordinary business data is untouched — the revoke was scoped, not broad.
      expect(await checkPermission(user, 'crm', 'read')).toBe(true);
      expect(await checkPermission(user, 'projects', 'read')).toBe(true);
    });
  });

  it('a tenant admin still reaches them', async () => {
    // The corner a careless fix breaks. `tenant_admin` holds ('*','*','*') —
    // "may do anything" has to keep meaning anything, or this stops being
    // confidentiality and becomes an outage.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'admin');
    await grantRole(db, user, 'tenant_admin');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'payroll', 'read')).toBe(true);
      expect(await checkPermission(user, 'employees', 'update')).toBe(true);
    });
  });

  it('an owner still reaches them', async () => {
    const { db } = await getTestApp();
    const user = await makeUser(db, 'owner');
    await grantRole(db, user, 'tenant_owner');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'payroll', 'read')).toBe(true);
    });
  });

  it('an explicit grant by name works — this is how an operator opts a role in', async () => {
    // Without this the rule would be a wall rather than a gate: an HR manager
    // who is not a tenant admin has to be able to hold exactly this.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'hr');
    const role = `hr_reader_${Date.now()}`;
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
      VALUES ('p', ${role}, '*', 'payroll', 'read')
    `.execute(db);
    await grantRole(db, user, role);
    await (await getEnforcer()).loadPolicy();

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'payroll', 'read')).toBe(true);
      // Named for payroll only — employees stays closed.
      expect(await checkPermission(user, 'employees', 'read')).toBe(false);
    });
  });

  it('a resource nobody granted is closed, without anyone listing it', async () => {
    // The point of deny-by-default: this needs no registry entry, no migration
    // and no foresight. A resource is closed because nothing opened it.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'unknown-res');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'medical_records', 'read')).toBe(false);
    });
  });

  it('default grants open ordinary resources and withhold sensitive ones', async () => {
    // What the sensitive registry decides now that the matcher no longer
    // consults it: not whether a grant matches, but whether one is written.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'materialize');
    await grantRole(db, user, 'tenant_member');

    registerSensitiveResources(['medical_records']);
    expect(listSensitiveResources()).toContain('medical_records');

    await materializeDefaultGrants(db, ['lab_results', 'medical_records']);
    await (await getEnforcer()).loadPolicy();
    await invalidateUserPermCache(user);

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'lab_results', 'read')).toBe(true);
      expect(await checkPermission(user, 'lab_results', 'update')).toBe(true);
      // Withheld — an operator grants this one by name or not at all.
      expect(await checkPermission(user, 'medical_records', 'read')).toBe(false);
    });
  });

  it('a partial wildcard grants nothing — this is the rule itself', async () => {
    // Every other test in this file would still pass with the old permissive
    // matcher, because migration 034 deleted the wildcard rows and left explicit
    // ones behind. That makes them a check on the migration, not on the rule.
    //
    // This one writes the offending row back and asserts it does nothing. It is
    // the test that fails if someone widens the matcher again, and the reason it
    // is worth having is that the original bug was invisible for exactly as long
    // as nobody thought to write a policy down and ask what it meant.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'wildcard');
    const role = `blanket_${Date.now()}`;
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
      VALUES ('p', ${role}, '*', '*', 'read')
    `.execute(db);
    await grantRole(db, user, role);

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'payroll', 'read')).toBe(false);
      // Not even for ordinary data: the grant names no resource, so it decides
      // nothing about any of them.
      expect(await checkPermission(user, 'contacts', 'read')).toBe(false);
    });

    // The total form still works — an administrator is a role, not a resource list.
    const boss = await makeUser(db, 'wildcard-total');
    const totalRole = `blanket_total_${Date.now()}`;
    await sql`
      INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3)
      VALUES ('p', ${totalRole}, '*', '*', '*')
    `.execute(db);
    await grantRole(db, boss, totalRole);

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(boss, 'payroll', 'read')).toBe(true);
      expect(await checkPermission(boss, 'contacts', 'delete')).toBe(true);
    });
  });

  it('a grant works the moment it is written, without a restart', async () => {
    // The regression this file's own helper should have prevented. That helper
    // calls `loadPolicy()` after inserting rows, with a comment saying a row
    // written behind the enforcer is invisible until reloaded — and the
    // production path was shipped without it. Casbin holds policies in memory,
    // both callers of `materializeDefaultGrants` run after the single boot-time
    // load, so a collection created at runtime answered 403 to every ordinary
    // user until someone restarted the engine.
    //
    // Deliberately does NOT reload before asserting. That is the whole point:
    // reloading here would test the same thing the other cases already do and
    // would pass against the broken build.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'live-grant');
    await grantRole(db, user, 'tenant_member');

    const resource = `live_widgets_${Date.now()}`;
    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, resource, 'read')).toBe(false);
    });

    const written = await materializeDefaultGrants(db, [resource]);
    expect(written).toBe(4); // read + create + update for member, read for viewer
    await invalidateUserPermCache(user);

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, resource, 'read')).toBe(true);
      expect(await checkPermission(user, resource, 'update')).toBe(true);
      // Still not everything — the reload must not widen anything.
      expect(await checkPermission(user, resource, 'delete')).toBe(false);
    });
  });

  it('a member cannot delete, which is how we know the guard can still refuse', async () => {
    // The negative control that made the original finding credible: DELETE was
    // never in `tenant_member`'s wildcard set and correctly returned 403 even
    // while payroll was wide open. It must stay refused now, or a test suite
    // that passes proves nothing about a build where authorization is broken.
    const { db } = await getTestApp();
    const user = await makeUser(db, 'no-delete');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'contacts', 'delete')).toBe(false);
    });
  });
});
