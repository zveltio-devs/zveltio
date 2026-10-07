/**
 * No non-god account exists without its `g <user> member *` row.
 *
 * Casbin is the one source of roles, and a row or column rule keyed on `member`
 * is a restriction: an account missing the row is not "less privileged", it is
 * out from under every such rule. The application wrote the row from
 * better-auth's `user.create.after` hook and from the demotion routes, which
 * left three ways to an account without it, each shown here:
 *
 * - better-auth runs `create.after` AFTER its sign-up transaction commits, so a
 *   grant that failed left the account and its password committed (500 to the
 *   client, a working sign-in afterwards). Provisioning queued the grant on
 *   `onAfterCommit`, whose failures are logged and dropped.
 * - an account written by anything but this release's hook — a 058 replica
 *   during a rolling upgrade (it reads `member` from the column and writes no
 *   row), the release binary's `create-god`, raw SQL — got no row at all.
 * - the recovery flow swallowed a failed grant for the god it demoted.
 *
 * The row is now written by a trigger on `"user"`, in the transaction that
 * creates or demotes the account (migration 059).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const RAW = `mrow-raw-${STAMP}`;
const FAIL_PREFIX = `mrow-fail-${STAMP}`;

async function memberRows(db: Database, user: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM zvd_permissions
     WHERE ptype = 'g' AND v0 = ${user} AND v1 = 'member' AND v2 = '*'
  `.execute(db);
  return r.rows[0]?.n ?? 0;
}

d('every non-god account holds `member` in Casbin', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DROP TRIGGER IF EXISTS zv_test_refuse_member ON zvd_permissions`.execute(db);
    await sql`DROP FUNCTION IF EXISTS zv_test_refuse_member()`.execute(db);
    await sql`DELETE FROM "user" WHERE id = ${RAW} OR email LIKE ${`${FAIL_PREFIX}%`}`.execute(db);
  });

  it('an account written outside the sign-up hook (old replica, raw SQL) holds the row', async () => {
    await sql`INSERT INTO "user" (id, name, email) VALUES (${RAW}, 'raw', ${`${RAW}@probe.invalid`})`.execute(
      db,
    );
    expect(await memberRows(db, RAW)).toBe(1);
  });

  it('a god demoted by any path holds the row, in the demoting transaction', async () => {
    const god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    await sql`DELETE FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${god} AND v1 = 'member'`.execute(
      db,
    );
    // As the recovery route demotes: one UPDATE, nothing else. Rolled back so
    // the harness keeps its god.
    let seen = -1;
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`UPDATE "user" SET role = 'member' WHERE id = ${god}`.execute(trx);
        seen = await memberRows(trx as Database, god);
        throw new Error('rollback');
      })
      .catch(() => {});
    expect(seen).toBe(1);
  });

  it('a sign-up whose grant fails leaves no account behind without the row', async () => {
    // The grant failing, as a database error would make it fail: refuse a
    // `member` row for exactly this test's accounts.
    await sql
      .raw(`
      CREATE OR REPLACE FUNCTION zv_test_refuse_member() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.v1 = 'member' AND EXISTS (SELECT 1 FROM "user" u
             WHERE u.id = NEW.v0 AND u.email LIKE '${FAIL_PREFIX}%') THEN
          RAISE EXCEPTION 'member grant refused (test)';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS zv_test_refuse_member ON zvd_permissions;
      CREATE TRIGGER zv_test_refuse_member BEFORE INSERT ON zvd_permissions
        FOR EACH ROW EXECUTE FUNCTION zv_test_refuse_member();
    `)
      .execute(db);
    const email = `${FAIL_PREFIX}@test.local`;
    const password = 'MemberUser123!';
    try {
      const res = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name: 'Fail' }),
      });
      expect(res.ok).toBe(false);
    } finally {
      await sql`DROP TRIGGER IF EXISTS zv_test_refuse_member ON zvd_permissions`.execute(db);
    }
    const left = await sql<{ id: string }>`SELECT id FROM "user" WHERE email = ${email}`.execute(
      db,
    );
    for (const { id } of left.rows) expect(await memberRows(db, id)).toBe(1);
    // And no password sign-in into a member-less account.
    if (left.rows.length === 0) {
      const signIn = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      expect(signIn.ok).toBe(false);
    }
  });

  it('PATCH /api/users/:id demotes a god to a member holding the row, without hanging', async () => {
    const god = (await sql<{ id: string }>`SELECT id FROM "user" WHERE role = 'god'`.execute(db))
      .rows[0]!.id;
    await sql`DELETE FROM zvd_permissions WHERE ptype = 'g' AND v0 = ${god} AND v1 = 'member'`.execute(
      db,
    );
    // The demotion's trigger row is uncommitted while the handler runs: a grant
    // written on the pool from inside the handler waits on it, and the handler
    // waits on the grant.
    const res = await Promise.race([
      app.request(`/api/users/${god}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify({ role: 'member' }),
      }),
      Bun.sleep(8_000).then(() => null),
    ]);
    try {
      expect(res?.status).toBe(200);
      expect(await memberRows(db, god)).toBe(1);
    } finally {
      await sql`UPDATE "user" SET role = 'god' WHERE id = ${god}`.execute(db);
      godCookie = await createGodSession(app, db);
    }
  });

  it('the baseline row cannot be taken away through the role route', async () => {
    const res = await app.request('/api/permissions/roles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ userId: RAW, role: 'member' }),
    });
    expect(res.status).toBe(422);
    expect(await memberRows(db, RAW)).toBe(1);
  });
});
