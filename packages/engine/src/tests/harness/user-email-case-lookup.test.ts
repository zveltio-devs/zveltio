/**
 * An account stored with an address in mixed case can be found by any spelling.
 *
 * better-auth lowercases the address it is given and then looks it up EXACTLY,
 * so a row stored as `Ana@X.ro` — older than that lowercasing, or written by an
 * SSO/SCIM extension with the IdP's spelling — was invisible to sign-in,
 * password reset, magic link and sign-up's existence check: its owner was
 * locked out. The engine's own admin lookups (`/api/tenants`) compared exactly
 * without lowercasing at all.
 *
 * The fix resolves the address to the spelling that is stored and leaves the
 * stored value alone. That is the half these tests pin as hard as the first:
 * a row rule `owner_email eq user_email` compares exactly against row values
 * written with the stored casing, so rewriting the stored address would have
 * cost its owner every row the rule granted.
 *
 * With migration 048's index missing (accounts sharing an address in another
 * case), the exact spelling wins and an ambiguous address matches nobody —
 * never a silent pick between two accounts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const COLLECTION = `ecl_${TAG}`;
const INDEX = 'user_email_lower_key';
const PASSWORD = 'HarnessMember123!';
/** Upper-cases the first letter of the local part and the domain: `Ab-c@Test.Local`. */
const legacySpelling = (email: string) =>
  email.replace(/^./, (c) => c.toUpperCase()).replace(/@test\.local$/, '@Test.Local');

d('a mixed-case stored address is found by any spelling', () => {
  let app: Hono;
  let db: Database;
  let god = '';
  let member: { cookie: string; userId: string; email: string };
  let stored = '';

  const signIn = (email: string, password = PASSWORD) =>
    app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  const cookieOf = (res: Response) =>
    (res.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');
  const signedInId = async (res: Response) => {
    const s = await app.request('/api/auth/get-session', { headers: { cookie: cookieOf(res) } });
    return ((await s.json()) as { user?: { id: string } } | null)?.user?.id;
  };
  /** An account with a password, then given a stored spelling the way a raw write would. */
  const accountStoredAs = async (spelling: string) => {
    const email = `made-ecl-${TAG}-${Math.floor(Math.random() * 1e9)}@test.local`;
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Legacy' }),
    });
    expect([200, 201]).toContain(res.status);
    const r = await sql<{ id: string }>`
      UPDATE "user" SET email = ${spelling} WHERE email = ${email} RETURNING id`.execute(db);
    return r.rows[0]!.id;
  };
  const titles = async (cookie: string) => {
    const res = await app.request(`/api/data/${COLLECTION}?sort=title`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ title: string }> };
    return body.records.map((r) => r.title).sort();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner_email', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    member = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    stored = legacySpelling(member.email);
    await sql`UPDATE "user" SET email = ${stored} WHERE id = ${member.userId}`.execute(db);
    await sql`
      INSERT INTO ${sql.table(`zvd_${COLLECTION}`)} (title, owner_email)
      VALUES ('stored-spelling', ${stored}), ('lowercase-spelling', ${member.email}),
             ('someone-else', 'someone-else@example.test')`.execute(db);
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, '*', 'owner_email', 'eq', 'user_email', TRUE)`.execute(db);
    const { invalidateRlsCache } = await import('../../lib/tenancy/rls.js');
    await invalidateRlsCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`.execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
    await sql`DELETE FROM zv_tenants WHERE slug LIKE ${`ecl-${TAG}%`}`.execute(db);
    await sql`DELETE FROM "user" WHERE lower(email) LIKE ${`%ecl-${TAG}%`} OR id = ${member?.userId ?? ''}`.execute(
      db,
    );
    await sql
      .raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON "user" (lower(email))`)
      .execute(db);
  });

  it('signs in with the lowercase spelling and with the stored one', async () => {
    for (const spelling of [member.email, stored, member.email.toUpperCase()]) {
      const res = await signIn(spelling);
      expect(res.status).toBe(200);
      expect(await signedInId(res)).toBe(member.userId);
    }
  });

  it('a wrong password is still refused', async () => {
    expect((await signIn(member.email, 'not-the-password')).status).toBe(401);
  });

  it('the stored address is not rewritten, and the email row rule grants exactly what it did', async () => {
    const res = await signIn(member.email);
    expect(res.status).toBe(200);
    const row = await sql<{ email: string }>`
      SELECT email FROM "user" WHERE id = ${member.userId}`.execute(db);
    expect(row.rows[0]?.email).toBe(stored);
    // The rule compares exactly: the row written with the stored spelling, and
    // nothing else — not the lowercase twin of it, not anyone else's.
    expect(await titles(cookieOf(res))).toEqual(['stored-spelling']);
  });

  it('sign-up with another spelling of the stored address is refused as an existing account', async () => {
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: member.email, password: PASSWORD, name: 'Twin' }),
    });
    expect(res.status).toBe(422);
    const n = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM "user" WHERE lower(email) = ${member.email}`.execute(db);
    expect(n.rows[0]?.n).toBe(1);
  });

  it('an administrator names the account in any spelling: tenant create and add member', async () => {
    const owner = legacySpelling(`owner-ecl-${TAG}@test.local`);
    const ownerId = await accountStoredAs(owner);
    const created = await app.request('/api/tenants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        slug: `ecl-${TAG}`,
        name: 'Ecl Co',
        admin_user_email: owner.toLowerCase(),
      }),
    });
    expect(created.status).toBe(201);
    const tenantId = ((await created.json()) as { tenant: { id: string } }).tenant.id;

    const added = await app.request(`/api/tenants/${tenantId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ user_email: member.email.toUpperCase(), role: 'member' }),
    });
    expect(added.status).toBe(201);
    const members = await sql<{ user_id: string }>`
      SELECT user_id FROM zv_tenant_users WHERE tenant_id = ${tenantId}::uuid ORDER BY user_id`.execute(
      db,
    );
    expect(members.rows.map((r) => r.user_id).sort()).toEqual([ownerId, member.userId].sort());
  });

  describe('with accounts sharing an address in another case (048 skipped its index)', () => {
    beforeAll(async () => {
      await sql.raw(`DROP INDEX IF EXISTS ${INDEX}`).execute(db);
    });

    it('the exact (lowercase) spelling wins; the other account is not reachable through it', async () => {
      const lower = `twin-ecl-${TAG}@test.local`;
      const mixed = await accountStoredAs(legacySpelling(lower));
      const exact = await accountStoredAs(lower);
      const res = await signIn(legacySpelling(lower));
      expect(res.status).toBe(200);
      expect(await signedInId(res)).toBe(exact);
      expect(await signedInId(res)).not.toBe(mixed);
    });

    it('an address no account holds exactly matches nobody rather than either twin', async () => {
      const lower = `amb-ecl-${TAG}@test.local`;
      await accountStoredAs(legacySpelling(lower));
      await accountStoredAs(lower.toUpperCase());
      for (const spelling of [lower, legacySpelling(lower), lower.toUpperCase()]) {
        expect((await signIn(spelling)).status).toBe(401);
      }
    });
  });
});
