/**
 * The name in a refusal comes from the database, so it is worth checking there.
 *
 * `denialSentence` is unit-tested against hand-built input. This is the half
 * that talks to Postgres: whether the query finds the right people, ignores the
 * wrong ones, and stays quiet rather than throwing — because a refusal that
 * fails while trying to be helpful becomes a 500, and the person loses both the
 * suggestion and the answer.
 *
 * Everything below is scoped to a tenant id invented for this file, so the rows
 * cannot change what any other test sees in the shared database.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import { describeDenial, whoCanGrant } from '../../lib/tenancy/index.js';

const d = harnessAvailable() ? describe : describe.skip;

/** A tenant nothing else in the suite knows about. */
const TENANT = '00000000-0000-0000-0000-00000000d001';

async function makeUser(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  name: string,
): Promise<string> {
  const id = `deny-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
    VALUES (${id}, ${name}, ${`${id}@test.local`}, false, 'member', NOW(), NOW())
  `.execute(db);
  return id;
}

async function grant(
  db: Awaited<ReturnType<typeof getTestApp>>['db'],
  userId: string,
  role: string,
  tenant: string,
): Promise<void> {
  await sql`
    INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', ${userId}, ${role}, ${tenant})
  `.execute(db);
}

d('who a refusal points at', () => {
  it('names the administrators of this tenant', async () => {
    const { db } = await getTestApp();
    const ana = await makeUser(db, 'Ana Popescu');
    const bogdan = await makeUser(db, 'Bogdan Ionescu');
    await grant(db, ana, 'tenant_admin', TENANT);
    await grant(db, bogdan, 'tenant_owner', TENANT);

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).toContain('Ana Popescu');
    expect(names).toContain('Bogdan Ionescu');
  });

  it('does not name a colleague who merely holds the resource', async () => {
    // The distinction that makes the suggestion useful rather than annoying: a
    // member with payroll access cannot give it to anyone, and sending someone
    // to them wastes two people's time.
    const { db } = await getTestApp();
    const carol = await makeUser(db, 'Carol Member');
    await grant(db, carol, 'tenant_member', TENANT);

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).not.toContain('Carol Member');
  });

  it('does not name administrators of a different tenant', async () => {
    const { db } = await getTestApp();
    const other = await makeUser(db, 'Dana OtherTenant');
    await grant(db, other, 'tenant_admin', '00000000-0000-0000-0000-00000000d999');

    const names = (await whoCanGrant(db, TENANT)).map((g) => g.name);
    expect(names).not.toContain('Dana OtherTenant');
  });

  it('caps the list, because fifteen names is not help', async () => {
    const { db } = await getTestApp();
    const many = '00000000-0000-0000-0000-00000000d002';
    for (let i = 0; i < 5; i++) {
      await grant(db, await makeUser(db, `Admin ${i}`), 'tenant_admin', many);
    }
    expect((await whoCanGrant(db, many)).length).toBeLessThanOrEqual(3);
  });

  it('separates a confidential resource from a missing grant', async () => {
    const { db } = await getTestApp();
    const secret = await describeDenial(db, 'payroll', 'read', TENANT);
    expect(secret.confidential).toBe(true);

    const ordinary = await describeDenial(db, 'contacts', 'read', TENANT);
    expect(ordinary.confidential).toBe(false);
  });

  it('returns nobody rather than throwing when the lookup cannot run', async () => {
    // Fails soft on purpose. Losing the name costs a plainer sentence; throwing
    // would turn the 403 into a 500 and lose the refusal itself.
    const broken = { executeQuery: () => Promise.reject(new Error('nope')) } as never;
    expect(await whoCanGrant(broken, TENANT)).toEqual([]);
  });
});
