/**
 * A blanket grant is not consent to read payroll.
 *
 * The seeded tenant roles give `tenant_member` `('*', '*', 'read')` — and
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
 * pin all four corners:
 *
 *   - a member still reaches ordinary data (nothing was broken to fix this)
 *   - a member does not reach sensitive data
 *   - an owner and a tenant admin still do
 *   - an explicit grant by name still does
 *
 * The third is the one that would have caught a careless fix: a rule that
 * blocked wildcards outright would lock administrators out of HR, which is not
 * confidentiality, it is breakage.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import {
  checkPermission,
  getEnforcer,
  invalidateUserPermCache,
  listSensitiveResources,
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

  it('an extension can declare its own data sensitive', async () => {
    const { db } = await getTestApp();
    const user = await makeUser(db, 'ext');
    await grantRole(db, user, 'tenant_member');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'medical_records', 'read')).toBe(true);
    });

    registerSensitiveResources(['medical_records']);
    expect(listSensitiveResources()).toContain('medical_records');

    await runWithDomain(TENANT, async () => {
      expect(await checkPermission(user, 'medical_records', 'read')).toBe(false);
    });
  });
});
