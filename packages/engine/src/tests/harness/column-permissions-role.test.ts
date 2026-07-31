/**
 * Column permissions are matched against the user's actual role.
 *
 * Every data handler resolved the role as `user.role ?? 'public'`, and
 * `session.user.role` is always undefined — `role` is not declared in
 * better-auth's `additionalFields`. The codebase knew the field was unreliable:
 * `lib/data/auth.ts` says so and routes authorization through
 * `checkPermission()` for exactly that reason. Column permissions kept reading
 * the field anyway, at fourteen sites.
 *
 * With every caller collapsing to `public`:
 *
 *   - a rule written for a NAMED role (`member`, `finance`) matched nobody, so
 *     the column it was meant to hide stayed visible — a permissive failure,
 *     not a conservative one;
 *   - an admin was evaluated as `public`, missing the admin short-circuit in
 *     getColumnAccess, so a `public` rule hid columns from administrators.
 *
 * Both directions wrong, from one undefined field.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcolperm_${Date.now()}`;

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-colperm-${Date.now()}@test.local`;
  const password = 'MemberUser123!';
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Member' }),
  });
  const userId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
  await sql`UPDATE "user" SET role = 'member' WHERE id = ${userId}`.execute(db);

  const enforcer = await getEnforcer();
  await enforcer.addPolicy(userId, '*', COLLECTION, 'read');
  await invalidateUserPermCache(userId);

  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (signIn.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
  return { cookie, userId };
}

d('column permissions resolve the real role (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';

  const firstRecord = async (cookie: string): Promise<Record<string, unknown>> => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<Record<string, unknown>> };
    return body.records[0] ?? {};
  };

  const setColumnPerm = async (role: string, column: string, canRead: boolean) => {
    const res = await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection_name: COLLECTION,
        column_name: column,
        role,
        can_read: canRead,
        can_write: canRead,
      }),
    });
    expect([200, 201]).toContain(res.status);
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    ({ cookie: memberCookie, userId: memberUserId } = await memberSession(app, db));

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'row', salary: '100000' }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    if (memberUserId) {
      const enforcer = await getEnforcer();
      await enforcer.removePolicy(memberUserId, '*', COLLECTION, 'read').catch(() => {});
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('hides a column from the named role it was written for', async () => {
    // The bug in one line: this rule names `member`, the handler asked for
    // `public`, and the member kept seeing the salary.
    await setColumnPerm('member', 'salary', false);
    const row = await firstRecord(memberCookie);
    expect(row.title).toBe('row');
    expect(row.salary).toBeUndefined();
  });

  it('does not hide it from an administrator', async () => {
    // getColumnAccess short-circuits for admin roles. Evaluating a god as
    // `public` skipped that, so a rule aimed at members could blind the admin
    // who wrote it.
    const row = await firstRecord(godCookie);
    expect(row.salary).toBe('100000');
  });

  it('a rule for a different role does not touch this member', async () => {
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`.execute(db);
    await setColumnPerm('finance', 'salary', false);
    const row = await firstRecord(memberCookie);
    expect(row.salary).toBe('100000');
  });

  it("a '*' rule still applies to everyone non-admin", async () => {
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`.execute(db);
    await setColumnPerm('*', 'salary', false);
    expect((await firstRecord(memberCookie)).salary).toBeUndefined();
  });
});
