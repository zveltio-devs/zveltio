/**
 * PUT, PATCH and DELETE by id refuse a row the caller cannot read.
 *
 * The before-row fetch in `handlers/single.ts` is the authorisation probe: it
 * carries the caller's row rules and every extension query alter, so a row
 * hidden from reads is "not found" for writes too. Nothing pinned that. Drop
 * `applyRlsFilters` or `queryAlterRegistry.applyAll` from any of the three
 * probes and the whole harness stayed green, while a member could overwrite or
 * delete another bucket's record by guessing its id.
 *
 * The harness pool is a superuser, so the generated RESTRICTIVE policy that
 * backs this up in production is not in play here: this measures the
 * application layer alone, which is the layer these probes are.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { queryAlterRegistry } from '../../lib/data/query-alter.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hswscope_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const ALTER_OWNER = 'harness-write-scope';
const ACTIONS = ['read', 'update', 'delete'] as const;
const openOnly = (qb: any) => qb.where('bucket', '=', 'open');

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-write-scope-${Date.now()}@test.local`;
  const password = 'MemberUser123!';
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Member' }),
  });
  const userId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
  await sql`UPDATE "user" SET role = 'member' WHERE id = ${userId}`.execute(db);

  const enforcer = await getEnforcer();
  for (const action of ACTIONS) await enforcer.addPolicy(userId, '*', COLLECTION, action);
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

d('data single writes honour the read scope (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';
  let policyId = '';

  const post = async (bucket: string): Promise<string> => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'original', bucket }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const write = (cookie: string, method: 'PUT' | 'PATCH' | 'DELETE', id: string) =>
    app.request(`/api/data/${COLLECTION}/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: method === 'DELETE' ? undefined : JSON.stringify({ title: 'overwritten' }),
    });

  const titleOf = async (id: string): Promise<string | undefined> =>
    (
      await sql<{ title: string }>`SELECT title FROM ${sql.table(TABLE)} WHERE id = ${id}`.execute(
        db,
      )
    ).rows[0]?.title;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    ({ cookie: memberCookie, userId: memberUserId } = await memberSession(app, db));

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    const policy = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
        description: 'members write only the open bucket',
      }),
    });
    expect(policy.status).toBe(201);
    policyId = ((await policy.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);
  });

  afterEach(() => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
  });

  afterAll(async () => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
    if (!db) return;
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
    }
    if (memberUserId) {
      const enforcer = await getEnforcer();
      for (const action of ACTIONS) {
        await enforcer.removePolicy(memberUserId, '*', COLLECTION, action).catch(() => {});
      }
    }
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    it(`${method} of a row the member's row rule hides is 404 and changes nothing`, async () => {
      const hiddenId = await post('restricted');
      expect((await write(memberCookie, method, hiddenId)).status).toBe(404);
      expect(await titleOf(hiddenId)).toBe('original');

      // The rule, not the route: the same member writes a row it can see.
      const openId = await post('open');
      expect((await write(memberCookie, method, openId)).status).toBe(200);
    });

    it(`${method} of a row a query alter hides is 404 and changes nothing`, async () => {
      const hiddenId = await post('restricted');
      queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, openOnly);
      // God: row rules do not apply, so only the alter can refuse.
      expect((await write(godCookie, method, hiddenId)).status).toBe(404);
      expect(await titleOf(hiddenId)).toBe('original');
    });
  }
});
