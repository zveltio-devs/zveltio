/**
 * The first administrator is made by better-auth (ADR 0056 d4).
 *
 * `create-god` wrote the `user` and `account` rows by hand: no password policy
 * (`--password abc` made a god), no audit row, and a private copy of the hash
 * and account format that had already drifted once from better-auth's. It now
 * goes through `createFirstAdmin`, which signs up through `auth.api.signUpEmail`
 * and promotes the account, under a lock that keeps a second god out.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createFirstAdmin, FirstAdminRefusedError } from '../../lib/first-admin.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PREFIX = `first-admin-${Date.now()}`;
const PASSWORD = 'FirstAdmin123!';
const ENGINE = join(import.meta.dir, '../../index.ts');

async function createGod(email: string, password = PASSWORD) {
  const proc = Bun.spawn(['bun', ENGINE, 'create-god', '--email', email, '--password', password], {
    env: { ...process.env, NATIVE_DATABASE_URL: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

d('first admin through better-auth', () => {
  let app: Hono;
  let db: Database;
  let savedGod: string | undefined;

  const rowsFor = async (email: string) =>
    (
      await sql<{ id: string; role: string; emailVerified: boolean }>`
        SELECT id, role, "emailVerified" FROM "user" WHERE lower(email) = ${email}`.execute(db)
    ).rows;
  // Stand the harness god down so the instance has none, as on a fresh install.
  const noGod = () => sql`UPDATE "user" SET role = 'member' WHERE role = 'god'`.execute(db);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    savedGod = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]?.id;
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM "user" WHERE email LIKE ${`${PREFIX}%`}`.execute(db);
    if (savedGod) await sql`UPDATE "user" SET role = 'god' WHERE id = ${savedGod}`.execute(db);
  });

  it('create-god makes a god that signs in through better-auth, and records it', async () => {
    await noGod();
    const email = `${PREFIX}-cli@test.local`;
    const { code, stderr } = await createGod(email);
    expect(stderr).not.toContain('create-god refused');
    // A CLI has no live Casbin model to load the `member` row into: nothing to
    // warn about (the row is the trigger's, migration 059).
    expect(stderr).not.toContain('member row not loaded');
    expect(code).toBe(0);

    const [user] = await rowsFor(email);
    expect(user).toMatchObject({ role: 'god', emailVerified: true });
    // The account row is better-auth's (argon2id through its password.hash), and
    // the session its sign-up opened went to nobody, so it is gone.
    const acct = await sql<{ password: string }>`
      SELECT password FROM account WHERE "userId" = ${user!.id} AND "providerId" = 'credential'`.execute(
      db,
    );
    expect(acct.rows[0]?.password).toStartWith('$argon2id$');
    const sessions = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM session WHERE "userId" = ${user!.id}`.execute(db);
    expect(sessions.rows[0]?.n).toBe(0);

    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(signIn.status).toBe(200);

    const audit = await sql<{ metadata: { reason?: string; role?: string } }>`
      SELECT metadata FROM zv_audit_log
       WHERE event_type = 'user.created' AND resource_id = ${user!.id}`.execute(db);
    expect(audit.rows[0]?.metadata).toMatchObject({ reason: 'first_admin', role: 'god' });
  });

  it('create-god refuses a second god, and creates no account trying', async () => {
    const email = `${PREFIX}-second@test.local`;
    const { code, stderr } = await createGod(email);
    expect(code).toBe(1);
    expect(stderr).toContain('already has its administrator');
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it("refuses a password better-auth's policy refuses", async () => {
    await noGod();
    const email = `${PREFIX}-weak@test.local`;
    await expect(createFirstAdmin(db, { email, password: 'abc' })).rejects.toThrow(/too short/i);
    expect(await rowsFor(email)).toHaveLength(0);
  });

  it('two at once make one god; the other is refused and leaves no account', async () => {
    await noGod();
    const emails = [`${PREFIX}-race-a@test.local`, `${PREFIX}-race-b@test.local`];
    const results = await Promise.allSettled(
      emails.map((email) => createFirstAdmin(db, { email, password: PASSWORD })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(FirstAdminRefusedError);
    const rows = [...(await rowsFor(emails[0]!)), ...(await rowsFor(emails[1]!))];
    expect(rows.map((r) => r.role)).toEqual(['god']);
  });
});
