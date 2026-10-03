/**
 * One account per address, whatever its case.
 *
 * `"user".email` carried a case-sensitive unique index, and the probes in front
 * of it disagreed: better-auth looks an address up exactly (after lowercasing
 * the input), the invite route exactly (without lowercasing), identity with
 * `lower()`. A row stored in another case — an SSO/LDAP/SCIM insert made with
 * the IdP's spelling, or a row older than better-auth's lowercasing — was
 * invisible to the exact probes, so sign-up and invitation acceptance created a
 * second account for the same mailbox. `provisionUser` then matched both and
 * returned whichever Postgres produced first: an IdP provisioning that address
 * could be handed the account somebody else had just signed up.
 *
 * Migration 048 puts a unique index on `lower(email)`; these tests drive each
 * write path with a case variant of an existing address.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { emailCaseDuplicates, provisionUser } from '../../lib/identity.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const INDEX = 'user_email_lower_key';

d('"user".email is unique case-insensitively', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const made: string[] = [];

  /** A row written the way an SSO extension or an old install wrote it: the case as given. */
  const rawUser = async (email: string) => {
    const id = `eci-${TAG}-${made.length}`;
    await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, 'Legacy', ${email})`.execute(db);
    made.push(id);
    return id;
  };
  const accounts = async (email: string) =>
    (
      await sql<{ id: string }>`
        SELECT id FROM "user" WHERE lower(email) = lower(${email}) ORDER BY id`.execute(db)
    ).rows.map((r) => r.id);
  const indexValid = async () =>
    (
      await sql<{ ok: boolean }>`
        SELECT i.indisvalid AND i.indisunique AS ok FROM pg_index i
         WHERE i.indexrelid = to_regclass(${INDEX})`.execute(db)
    ).rows[0]?.ok === true;
  /** Migration 048's UP, the way the runner applies a transactional file. */
  const migrate048 = async () => {
    const file = new URL(
      '../../db/migrations/sql/048_user_email_lower_unique.sql',
      import.meta.url,
    );
    const { up } = parseMigrationFile(await Bun.file(file).text());
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(up)) await sql.raw(stmt).execute(trx);
    });
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`DELETE FROM "user" WHERE id LIKE ${`eci-${TAG}-%`} OR email LIKE ${`%eci-${TAG}%`}`.execute(
      db,
    );
    // A failed migration test must not leave the rest of the run without the index.
    if (!(await indexValid())) await migrate048();
  });

  it('the database refuses a case variant of an existing address', async () => {
    await rawUser(`Raw-eci-${TAG}@Test.Local`);
    const err = await rawUser(`raw-eci-${TAG}@test.local`).catch((e: unknown) => e);
    expect((err as { errno?: string }).errno).toBe('23505');
    expect(String((err as Error).message)).toContain(INDEX);
  });

  it('sign-up with a case variant of an existing account creates no second account', async () => {
    const legacy = await rawUser(`Signup-eci-${TAG}@Test.Local`);
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `signup-eci-${TAG}@test.local`,
        password: 'Test12345!',
        name: 'Twin',
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await accounts(`signup-eci-${TAG}@test.local`)).toEqual([legacy]);
  });

  it('inviting a case variant of an existing account is refused at the invite', async () => {
    await rawUser(`Invite-eci-${TAG}@test.local`);
    const res = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email: `INVITE-eci-${TAG}@test.local` }),
    });
    expect(res.status).toBe(409);
  });

  it('accepting an invitation whose address was taken in another case is email_taken, not a twin', async () => {
    const email = `accept-eci-${TAG}@test.local`;
    const invited = await app.request('/api/users/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email }),
    });
    expect(invited.status).toBe(201);
    const token = new URL(
      ((await invited.json()) as { invite_url: string }).invite_url,
    ).searchParams.get('token');
    // Meanwhile an SSO login created the account with the IdP's spelling.
    const legacy = await rawUser(`Accept-eci-${TAG}@Test.Local`);

    const res = await app.request('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: 'Test12345!', name: 'Twin' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('email_taken');
    expect(await accounts(email)).toEqual([legacy]);
    const open = await sql<{ accepted_at: Date | null }>`
      SELECT accepted_at FROM zv_invitations WHERE email = ${email}`.execute(db);
    expect(open.rows[0]?.accepted_at).toBeNull();
  });

  it('provisionUser with a case variant returns the existing account', async () => {
    const legacy = await rawUser(`Prov-eci-${TAG}@Test.Local`);
    const r = await provisionUser({ email: `PROV-eci-${TAG}@test.local` }, 'test');
    expect(r).toMatchObject({ created: false, user: { id: legacy } });
    expect(await accounts(`prov-eci-${TAG}@test.local`)).toEqual([legacy]);
  });

  it('migration 048 builds the index and is a no-op the second time', async () => {
    await sql.raw(`DROP INDEX IF EXISTS ${INDEX}`).execute(db);
    await migrate048();
    expect(await indexValid()).toBe(true);
    await migrate048();
    expect(await indexValid()).toBe(true);
  });

  it('with case duplicates present, 048 still applies, builds nothing, and names them', async () => {
    await sql.raw(`DROP INDEX IF EXISTS ${INDEX}`).execute(db);
    const a = await rawUser(`Dup-eci-${TAG}@Test.Local`);
    const b = await rawUser(`dup-eci-${TAG}@test.local`);

    await migrate048(); // an upgrade must not stop here
    expect(await indexValid()).toBe(false);
    const dups = await emailCaseDuplicates(db);
    expect(dups).toContainEqual({ email: `dup-eci-${TAG}@test.local`, ids: [a, b].sort() });

    const health = await app.request('/api/health/deep', { headers: { cookie } });
    const checks = ((await health.json()) as { checks: Record<string, { ok: boolean }> }).checks;
    expect(checks.email_uniqueness?.ok).toBe(false);

    // The operator merges the accounts; the next run builds the index.
    await sql`DELETE FROM "user" WHERE id = ${b}`.execute(db);
    await migrate048();
    expect(await indexValid()).toBe(true);
    expect(await emailCaseDuplicates(db)).toEqual([]);
  });
});
