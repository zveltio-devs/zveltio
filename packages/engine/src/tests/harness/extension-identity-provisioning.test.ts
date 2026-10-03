/**
 * Identity provisioning through `ctx.internals` (`identity:provision`).
 *
 * auth/scim, auth/ldap and auth/saml created users, joined them to tenants and
 * renamed them with raw SQL on `ctx.db`. Since #858 that SQL meets the table
 * allowlist and is refused — first test — so directory sign-in and SCIM
 * provisioning stopped. The engine now does those writes itself, for the
 * tenant the work runs as, and never makes a god or an admin.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { CapabilityDeniedError, gateInternals } from '../../lib/extensions/capabilities.js';
import {
  createRestrictedDb,
  ExtensionSecurityError,
} from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { isSingleTenantInstance } from '../../lib/identity.js';
import {
  DEFAULT_TENANT_ID,
  getCurrentTenantTrx,
  getEnforcer,
  runWithTenantTrx,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** Until some statement on this database waits on a lock (the race under test). */
async function waitForLockWaiter(db: Database): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (r.rows[0]!.n > 0) return;
    await Bun.sleep(25);
  }
  throw new Error('no statement ever waited on the lock');
}

const TAG = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const hex = TAG.slice(-12).padStart(12, '0');
const T = `00000000-0000-0000-0dd1-${hex}`; // the tenant the IdP speaks for
const T2 = `00000000-0000-0000-0dd2-${hex}`; // somebody else's

d('identity provisioning through ctx.internals', () => {
  let db: Database;
  let ext: Database; // what auth/scim's ctx.db is
  const scim = gateInternals('auth/scim', buildExtensionInternals(), ['identity:provision']);
  const bare = gateInternals('auth/scim', buildExtensionInternals(), ['auth:users']);
  const as = <R>(tenant: string, fn: (trx: Database) => Promise<R>) =>
    buildExtensionInternals().withTenantIsolation(tenant, () => fn(ext));

  const makeUser = async (label: string, role = 'member') => {
    const id = `idp-${label}-${TAG}-${Math.floor(Math.random() * 1e6)}`;
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
              VALUES (${id}, ${label}, ${`${id}@test.local`}, false, ${role}, now(), now())`.execute(
      db,
    );
    return id;
  };
  const enrol = (tenant: string, user: string, role = 'member', lapsed = false) =>
    sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
        VALUES (${tenant}::uuid, ${user}, ${role}, now() - interval '2 days',
                ${lapsed ? sql`now() - interval '1 day'` : sql`NULL`})`.execute(db);
  const membership = async (tenant: string, user: string) =>
    (
      await sql<{ role: string; valid_to: Date | null }>`
        SELECT role, valid_to FROM zv_tenant_users
         WHERE tenant_id = ${tenant}::uuid AND user_id = ${user}`.execute(db)
    ).rows[0];
  const grades = async (user: string) =>
    (await (await getEnforcer()).getFilteredGroupingPolicy(0, user)).map((g) => `${g[1]}@${g[2]}`);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    ext = createRestrictedDb(() => getCurrentTenantTrx() ?? db, 'auth/scim', new Set());
    await sql`INSERT INTO zv_tenants (id, slug, name, status) VALUES
                (${T}::uuid, ${`idp-a-${TAG}`}, 'idp A', 'active'),
                (${T2}::uuid, ${`idp-b-${TAG}`}, 'idp B', 'active')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_tenants WHERE id IN (${T}::uuid, ${T2}::uuid)`.execute(db);
    await sql`DELETE FROM "user" WHERE id LIKE ${`idp-%-${TAG}-%`}
                                OR email LIKE ${`%-${TAG}@idp.test`}`.execute(db);
  });

  it('the raw SQL the three extensions ran is refused on ctx.db (why this API exists)', async () => {
    const id = `idp-raw-${TAG}-0`;
    await expect(
      sql`INSERT INTO "user" (id, email, name, "emailVerified", "createdAt", "updatedAt")
          VALUES (${id}, ${`${id}@test.local`}, 'x', true, now(), now())`.execute(ext),
    ).rejects.toBeInstanceOf(ExtensionSecurityError);
    await expect(
      sql`SELECT COUNT(*)::int AS n FROM zv_tenants`.execute(ext),
    ).rejects.toBeInstanceOf(ExtensionSecurityError);
    await expect(
      sql`INSERT INTO zv_tenant_users (tenant_id, user_id) VALUES (${T}::uuid, 'x')`.execute(ext),
    ).rejects.toBeInstanceOf(ExtensionSecurityError);
  });

  it('is gated identity:provision, and the acting members have no caller outside the gate', () => {
    for (const m of [
      'provisionUser',
      'listTenantUsers',
      'updateUserProfile',
      'addTenantMember',
      'removeTenantMember',
      'setTenantMembershipEnd',
    ] as const) {
      expect(() => (bare[m] as (...a: unknown[]) => unknown)(db, 'u', {})).toThrow(
        CapabilityDeniedError,
      );
    }
    expect(() => buildExtensionInternals().provisionUser({ email: 'a@b.c' })).toThrow(
      'gateInternals',
    );
    expect(() => buildExtensionInternals().addTenantMember(db, 'u')).toThrow('gateInternals');
  });

  it('provisionUser: find-or-create, verified, passwordless, never god, even with sign-up off', async () => {
    const email = `New.Person-${TAG}@IDP.test`;
    const prev = process.env.ZVELTIO_REGISTRATION_ENABLED;
    process.env.ZVELTIO_REGISTRATION_ENABLED = '0';
    let first: Awaited<ReturnType<typeof scim.provisionUser>>;
    try {
      first = await as(T, () => scim.provisionUser({ email, name: 'New Person' }));
    } finally {
      process.env.ZVELTIO_REGISTRATION_ENABLED = prev;
    }
    expect(first.created).toBe(true);
    expect(first.user).toMatchObject({
      email: email.toLowerCase(),
      name: 'New Person',
      emailVerified: true,
    });
    const row = (
      await sql<{ role: string; accounts: number; tenants: number }>`
        SELECT u.role,
               (SELECT COUNT(*)::int FROM account a WHERE a."userId" = u.id) AS accounts,
               (SELECT COUNT(*)::int FROM zv_tenant_users tu WHERE tu.user_id = u.id) AS tenants
          FROM "user" u WHERE u.id = ${first.user.id}`.execute(db)
    ).rows[0]!;
    expect(row).toEqual({ role: 'member', accounts: 0, tenants: 0 });

    const again = await as(T, () => scim.provisionUser({ email: email.toUpperCase() }));
    expect(again).toEqual({ user: first.user, created: false });
    const audit = await sql`SELECT 1 FROM zv_audit_log WHERE event_type = 'user.created'
                             AND resource_id = ${first.user.id}
                             AND metadata->>'actor' = 'ext:auth/scim'`.execute(db);
    expect(audit.rows).toHaveLength(1);
    await expect(scim.provisionUser({ email: 'not an email' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it("listTenantUsers: the running tenant's members, lapsed included, nobody else's", async () => {
    const [mine, lapsed, theirs] = [
      await makeUser('mine'),
      await makeUser('lapsed'),
      await makeUser('theirs'),
    ];
    await enrol(T, mine);
    await enrol(T, lapsed, 'member', true);
    await enrol(T2, theirs);

    const listed = await as(T, (trx) => scim.listTenantUsers(trx, { limit: 1000 }));
    const ids = listed.map((u) => u.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(lapsed);
    expect(ids).not.toContain(theirs);
    const l = listed.find((u) => u.id === lapsed)!;
    expect(l.membership).toMatchObject({ role: 'member', inForce: false });
    expect(Date.parse(l.membership!.validTo!)).toBeLessThan(Date.now());
    expect(listed.find((u) => u.id === mine)!.membership!.inForce).toBe(true);

    const byEmail = await as(T, (trx) =>
      scim.listTenantUsers(trx, { email: `${mine}@TEST.local`.toUpperCase() }),
    );
    expect(byEmail.map((u) => u.id)).toEqual([mine]);
    expect(await as(T, (trx) => scim.listTenantUsers(trx, { userId: theirs }))).toEqual([]);
    await expect(scim.listTenantUsers(ext)).rejects.toMatchObject({ code: 'no_tenant' });
  });

  it('updateUserProfile: only a user the running tenant alone holds', async () => {
    const owned = await makeUser('owned');
    const shared = await makeUser('shared');
    // One god per instance (migration 008): reuse it when another suite made it.
    const god =
      (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db)).rows[0]
        ?.id ?? (await makeUser('god', 'god'));
    const starRole = await makeUser('star');
    await enrol(T, owned);
    await enrol(T, shared);
    await enrol(T2, shared);
    await enrol(T, god); // goes with T in afterAll
    await enrol(T, starRole);
    await (await getEnforcer()).addRoleForUser(starRole, 'admin', '*');

    const renamed = await as(T, (trx) =>
      scim.updateUserProfile(trx, owned, { name: 'Renamed', email: `Moved-${TAG}@idp.test` }),
    );
    expect(renamed).toMatchObject({ id: owned, name: 'Renamed', email: `moved-${TAG}@idp.test` });

    for (const id of [shared, god, starRole]) {
      await expect(
        as(T, (trx) => scim.updateUserProfile(trx, id, { email: `hijack-${TAG}@evil.test` })),
      ).rejects.toMatchObject({ code: 'user_not_owned' });
    }
    expect(
      (await sql<{ email: string }>`SELECT email FROM "user" WHERE id = ${shared}`.execute(db))
        .rows[0]!.email,
    ).toBe(`${shared}@test.local`);

    // Taken email: refused, and the caller's transaction is still usable after it.
    const other = await makeUser('other');
    const after = await as(T, async (trx) => {
      await expect(
        scim.updateUserProfile(trx, owned, { email: `${other}@test.local` }),
      ).rejects.toMatchObject({ code: 'email_taken' });
      return scim.updateUserProfile(trx, owned, { name: 'Still works' });
    });
    expect(after.name).toBe('Still works');
  });

  it('updateUserProfile: an instance admin is not the default tenant’s to rename', async () => {
    const admin = await makeUser('iadmin');
    await (await getEnforcer()).addRoleForUser(admin, 'admin', DEFAULT_TENANT_ID);
    await expect(
      as(DEFAULT_TENANT_ID, (trx) => scim.updateUserProfile(trx, admin, { name: 'x' })),
    ).rejects.toMatchObject({ code: 'user_not_owned' });
  });

  it('addTenantMember: member/viewer of the running tenant only, with its Casbin grade', async () => {
    const u = await makeUser('joiner');
    expect(await as(T, (trx) => scim.addTenantMember(trx, u))).toBe('added');
    expect(await membership(T, u)).toMatchObject({ role: 'member', valid_to: null });
    expect(await grades(u)).toEqual([`tenant_member@${T}`]);
    expect(await as(T, (trx) => scim.addTenantMember(trx, u, 'viewer'))).toBe('role_changed');
    expect(await grades(u)).toEqual([`tenant_viewer@${T}`]);
    expect(await as(T, (trx) => scim.addTenantMember(trx, u, 'viewer'))).toBe('unchanged');

    await expect(
      as(T, (trx) => scim.addTenantMember(trx, u, 'admin' as 'member')),
    ).rejects.toMatchObject({ code: 'role_not_allowed' });
    const owner = await makeUser('owner');
    await enrol(T, owner, 'owner');
    await expect(as(T, (trx) => scim.addTenantMember(trx, owner))).rejects.toMatchObject({
      code: 'role_not_allowed',
    });
    expect((await membership(T, owner))!.role).toBe('owner');
    // No tenant runs: nothing to join (entering T needs tenant:enter).
    await expect(scim.addTenantMember(ext, u)).rejects.toMatchObject({ code: 'no_tenant' });
    await expect(as(T, (trx) => scim.addTenantMember(trx, 'nobody'))).rejects.toMatchObject({
      code: 'no_such_user',
    });
  });

  it('addTenantMember does not reopen a membership the business ended', async () => {
    const u = await makeUser('ended');
    await enrol(T, u, 'member', true);
    expect(await as(T, (trx) => scim.addTenantMember(trx, u))).toBe('unchanged');
    expect((await membership(T, u))!.valid_to).not.toBeNull();
  });

  it('removeTenantMember: drops the grades; orphaned only when this tenant held it alone', async () => {
    const alone = await makeUser('alone');
    await as(T, (trx) => scim.addTenantMember(trx, alone));
    expect(await as(T, (trx) => scim.removeTenantMember(trx, alone))).toEqual({
      removed: true,
      orphaned: true,
      inForceAnywhere: false,
    });
    expect(await membership(T, alone)).toBeUndefined();
    expect(await grades(alone)).toEqual([]);

    const both = await makeUser('both');
    await enrol(T, both);
    await enrol(T2, both);
    expect(await as(T, (trx) => scim.removeTenantMember(trx, both))).toEqual({
      removed: true,
      orphaned: false,
      inForceAnywhere: true,
    });

    // A user T never had is never reported orphaned to T.
    const stranger = await makeUser('stranger');
    expect(await as(T, (trx) => scim.removeTenantMember(trx, stranger))).toEqual({
      removed: false,
      orphaned: false,
      inForceAnywhere: false,
    });
  });

  it('setTenantMembershipEnd: suspend in force, resend is a no-op, restore only an unchanged end', async () => {
    const u = await makeUser('suspend');
    await enrol(T, u);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await sql`UPDATE zv_tenant_users SET valid_to = ${until}::timestamptz
               WHERE tenant_id = ${T}::uuid AND user_id = ${u}`.execute(db);

    const ended = await as(T, (trx) =>
      scim.setTenantMembershipEnd(trx, u, 'now', { ifInForce: true }),
    );
    expect(ended).toMatchObject({ changed: true, inForceAnywhere: false });
    expect(Date.parse(ended!.previousValidTo!)).toBe(Date.parse(until));

    const resent = await as(T, (trx) =>
      scim.setTenantMembershipEnd(trx, u, 'now', { ifInForce: true }),
    );
    expect(resent).toMatchObject({ changed: false, previousValidTo: ended!.validTo });

    // A date somebody wrote since wins over the restore.
    const stale = '2020-01-01T00:00:00.000000Z';
    const refused = await as(T, (trx) =>
      scim.setTenantMembershipEnd(trx, u, ended!.previousValidTo, { ifValidTo: stale }),
    );
    expect(refused!.changed).toBe(false);

    const restored = await as(T, (trx) =>
      scim.setTenantMembershipEnd(trx, u, ended!.previousValidTo, { ifValidTo: ended!.validTo }),
    );
    expect(restored).toMatchObject({ changed: true, inForceAnywhere: true });
    expect(Date.parse(restored!.validTo!)).toBe(Date.parse(until));

    expect(await as(T2, (trx) => scim.setTenantMembershipEnd(trx, u, 'now'))).toBeNull();
    await expect(
      as(T, (trx) => scim.setTenantMembershipEnd(trx, u, 'tomorrow-ish')),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('isSingleTenantInstance is ungated and sees the tenants this suite made', async () => {
    expect(await bare.isSingleTenantInstance()).toBe(false);
  });

  // The account and the Casbin grade used to be written on other connections
  // (better-auth's pool, the enforcer's), so a provisioning step that failed
  // after them rolled back the membership and left the account and the grade.
  it('a rolled-back provisioning leaves no account and no grade; a rolled-back removal keeps both', async () => {
    const email = `rolled-${TAG}@idp.test`;
    const joiner = await makeUser('rolled');
    const planted = new Error('a later provisioning step failed');
    await expect(
      as(T, async (trx) => {
        const { user, created } = await scim.provisionUser({ email });
        expect(created).toBe(true);
        await scim.addTenantMember(trx, user.id);
        await scim.addTenantMember(trx, joiner);
        throw planted;
      }),
    ).rejects.toBe(planted);
    const left = await sql`SELECT 1 FROM "user" WHERE email = ${email}`.execute(db);
    expect(left.rows).toHaveLength(0);
    expect(await membership(T, joiner)).toBeUndefined();
    expect(await grades(joiner)).toEqual([]);
    const rows = await sql`SELECT 1 FROM zvd_permissions WHERE v0 = ${joiner}`.execute(db);
    expect(rows.rows).toHaveLength(0);

    // Committed, the same steps land, account included.
    const done = await as(T, async (trx) => {
      const { user } = await scim.provisionUser({ email });
      await scim.addTenantMember(trx, user.id);
      return user;
    });
    expect(await grades(done.id)).toEqual([`tenant_member@${T}`]);

    await expect(
      as(T, async (trx) => {
        await scim.removeTenantMember(trx, done.id);
        throw planted;
      }),
    ).rejects.toBe(planted);
    expect((await membership(T, done.id))!.role).toBe('member');
    expect(await grades(done.id)).toEqual([`tenant_member@${T}`]);
  });

  it('two transactions provisioning one email: the second gets the first account, its own transaction intact', async () => {
    const email = `twice-${TAG}@idp.test`;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstCreated!: () => void;
    const created = new Promise<void>((r) => {
      firstCreated = r;
    });
    const first = as(T, async () => {
      const r = await scim.provisionUser({ email });
      firstCreated();
      await gate;
      return r;
    });
    await created;
    const second = as(T, async (trx) => {
      const r = await scim.provisionUser({ email });
      await scim.addTenantMember(trx, r.user.id);
      return r;
    });
    await waitForLockWaiter(db);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.created).toBe(true);
    expect(b).toEqual({ user: a.user, created: false });
    expect((await membership(T, a.user.id))!.role).toBe('member');
  });

  // Probe-then-write: a concurrent writer of the same email passed the probe and
  // then failed the unique index, aborting the caller's transaction (25P02).
  it('updateUserProfile: an email another transaction is writing is email_taken, transaction intact', async () => {
    const mover = await makeUser('mover');
    await enrol(T, mover);
    const target = `race-${TAG}@idp.test`;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const written = new Promise<void>((r) => {
      inserted = r;
    });
    const holder = db.transaction().execute(async (trx) => {
      await sql`INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt")
                VALUES (${`idp-racer-${TAG}-1`}, 'racer', ${target}, false, 'member', now(), now())`.execute(
        trx,
      );
      inserted();
      await gate;
    });
    await written;
    const result = as(T, async (trx) => {
      const r = await scim.updateUserProfile(trx, mover, { email: target }).then(
        () => 'updated',
        (e: { code?: string; message?: string }) => e.code ?? e.message,
      );
      return [r, (await scim.updateUserProfile(trx, mover, { name: 'after race' })).name];
    });
    await waitForLockWaiter(db);
    release();
    await holder;
    expect(await result).toEqual(['email_taken', 'after race']);
  });

  // `isSingleTenantInstance` is true when at most one zv_tenants row exists. The
  // harness has many, so they are hidden inside a transaction that is rolled back
  // (replica mode: no FK action or check fires on the hidden rows).
  it('single-tenant instance: the default tenant holds every account', async () => {
    const solo = await makeUser('solo');
    const starEditor = await makeUser('star-editor');
    await (await getEnforcer()).addRoleForUser(starEditor, 'editor', '*');
    const multi = await as(DEFAULT_TENANT_ID, (trx) => scim.listTenantUsers(trx, { userId: solo }));
    expect(multi).toEqual([]);

    const rollback = new Error('rollback');
    const seen = await db
      .transaction()
      .execute(async (trx) => {
        await sql`SET LOCAL session_replication_role = replica`.execute(trx);
        await sql`DELETE FROM zv_tenants WHERE id <> ${DEFAULT_TENANT_ID}::uuid`.execute(trx);
        const out = await runWithTenantTrx(trx, DEFAULT_TENANT_ID, async () => ({
          single: await isSingleTenantInstance(trx),
          listed: await scim.listTenantUsers(trx, { userId: solo }),
          renamed: (await scim.updateUserProfile(trx, starEditor, { name: 'Solo editor' })).name,
          removed: await scim.removeTenantMember(trx, solo),
        }));
        throw Object.assign(rollback, { out });
      })
      .catch((e: Error & { out?: unknown }) => {
        if (e !== rollback) throw e;
        return e.out;
      });
    expect(seen).toMatchObject({
      single: true,
      listed: [{ id: solo, membership: null }],
      renamed: 'Solo editor',
      // No row to remove, yet the default tenant held the account alone.
      removed: { removed: false, orphaned: true, inForceAnywhere: false },
    });
    // Multi-tenant again: the '*' grant is power the instance gave.
    await expect(
      as(DEFAULT_TENANT_ID, (trx) => scim.updateUserProfile(trx, starEditor, { name: 'x' })),
    ).rejects.toMatchObject({ code: 'user_not_owned' });
  });
});
