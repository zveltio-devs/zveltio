/**
 * A row rule keyed on `member` applies to a self-registered member over REST.
 *
 * Such a user holds `member` only in the `"user".role` column — no Casbin `g`
 * row, which only `PATCH /api/users/:id` writes. `getRlsFilters` took the
 * column role from `user.role` on the object its caller passed: the realtime
 * doors resolved it, REST did not, so the same rule filtered this user's
 * socket and stood down on `GET /api/data`. Nothing else caught it: the
 * generated database policy exists, but a collection table has RLS enabled
 * only in multi-tenant mode, and `?as_of=` reads `zv_revisions`, which no row
 * rule covers — so the member read every owner's rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  getEnforcer,
  getUserRoles,
  invalidateUserPermCache,
} from '../../lib/tenancy/permissions.js';
import { getRlsFilters, invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrlscolrole_${Date.now()}`;

d('a member-keyed row rule applies to a column-role member over REST', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let cookie = '';
  let userId = '';
  let mineId = '';
  let theirsId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    // Self-registration, untouched: the column default is the only role.
    const email = `harness-colrole-${Date.now()}@test.local`;
    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Member' }),
    });
    userId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    expect(userId).toBeTruthy();
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    cookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    // A direct grant, so Casbin lets the user read — and still no `g` row.
    await (await getEnforcer()).addPolicy(userId, '*', COLLECTION, 'read');
    await invalidateUserPermCache(userId);

    const rule = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: 'member',
        filter_field: 'owner',
        filter_op: 'eq',
        filter_value_source: 'user_id',
      }),
    });
    expect(rule.status).toBe(201);
    await invalidateRlsCache(COLLECTION);

    const post = async (body: Record<string, string>) => {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(body),
      });
      return ((await res.json()) as { id: string }).id;
    };
    mineId = await post({ title: 'mine', owner: userId });
    theirsId = await post({ title: 'theirs', owner: 'someone-else' });
    expect(mineId).toBeTruthy();
    expect(theirsId).toBeTruthy();
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    if (userId) {
      await (await getEnforcer()).removePolicy(userId, '*', COLLECTION, 'read').catch(() => {});
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

  it('the premise: member is a column role only, with no Casbin grouping', async () => {
    const row = await sql<{ role: string }>`SELECT role FROM "user" WHERE id = ${userId}`.execute(
      db,
    );
    expect(row.rows[0]?.role).toBe('member');
    expect(await getUserRoles(userId)).not.toContain('member');
  });

  it('getRlsFilters applies the rule whether or not the caller passed the role', async () => {
    const bare = await getRlsFilters(COLLECTION, { id: userId }, 'session');
    const withRole = await getRlsFilters(COLLECTION, { id: userId, role: 'member' }, 'session');
    expect(bare).toEqual([{ field: 'owner', condition: { op: 'eq', value: userId } }]);
    expect(bare).toEqual(withRole);
  });

  it('an API key keeps its constructed `api_key` role, and gains no `public`', async () => {
    const key = `apikey:${crypto.randomUUID()}`;
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, 'api_key', 'title', 'eq', 'static:k', true),
             (${COLLECTION}, 'public', 'title', 'eq', 'static:p', true)
    `.execute(db);
    await invalidateRlsCache(COLLECTION);
    try {
      const expected: Awaited<ReturnType<typeof getRlsFilters>> = [
        { field: 'title', condition: { op: 'eq', value: 'k' } },
      ];
      expect(await getRlsFilters(COLLECTION, { id: key, role: 'api_key' }, 'api_key')).toEqual(
        expected,
      );
      expect(await getRlsFilters(COLLECTION, { id: key }, 'api_key')).toEqual(expected);
    } finally {
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION} AND role IN ('api_key', 'public')`.execute(
        db,
      );
      await invalidateRlsCache(COLLECTION);
    }
  });

  it('list GET returns only their own row', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { records: Array<{ id: string }> }).records.map((r) => r.id);
    expect(ids).toEqual([mineId]);
  });

  it('?as_of= returns only their own row', async () => {
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const res = await app.request(`/api/data/${COLLECTION}?as_of=${encodeURIComponent(asOf)}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { records: Array<{ id: string }> }).records.map((r) => r.id);
    expect(ids).toEqual([mineId]);
  });
});
