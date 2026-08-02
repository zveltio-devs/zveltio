/**
 * RLS `in` / `not_in` policies actually filter.
 *
 * `routes/rls.ts` validates `filter_op` against a four-value enum
 * (eq | neq | in | not_in), so an administrator could save an `in` policy, see
 * it listed as enabled, and believe it was hiding rows. `applyRlsFilters`
 * implemented only `eq` and `neq` and dropped the rest — the policy did nothing
 * at all. A security control that is configurable, stored, displayed and inert
 * is worse than one that does not exist, because nobody goes looking for it.
 *
 * End-to-end through the data API with a real member session, because the claim
 * is about which rows a user gets back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlrlsin_${Date.now()}`;

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-list-in-${Date.now()}@test.local`;
  const password = 'MemberUser123!';

  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Member' }),
  });
  const signUpBody = (await signUp.json()) as { user?: { id: string } };
  const userId = signUpBody.user?.id ?? '';
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

d('data list RLS in/not_in (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';
  let policyId = '';

  const titlesFor = async (cookie: string): Promise<string[]> => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records?: Array<{ title: string }> };
    return (body.records ?? []).map((r) => r.title).sort();
  };

  const setPolicy = async (op: string, source: string) => {
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`.execute(db);
    }
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: op,
        filter_value_source: source,
        description: `${op} policy`,
      }),
    });
    expect(res.status).toBe(201);
    policyId = ((await res.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);
  };

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

    const post = (body: Record<string, string>) =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(body),
      });
    await post({ title: 'alpha', bucket: 'red' });
    await post({ title: 'beta', bucket: 'green' });
    await post({ title: 'gamma', bucket: 'blue' });
  });

  afterAll(async () => {
    if (!db) return;
    if (policyId) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${policyId}::uuid`
        .execute(db)
        .catch(() => {});
    }
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

  it('an `in` policy restricts to the listed values', async () => {
    // This is the whole bug: before, the member saw all three.
    await setPolicy('in', 'static:red,blue');
    expect(await titlesFor(memberCookie)).toEqual(['alpha', 'gamma']);
  });

  it('a `not_in` policy excludes the listed values', async () => {
    await setPolicy('not_in', 'static:red,blue');
    expect(await titlesFor(memberCookie)).toEqual(['beta']);
  });

  it('tolerates spaces in the list', async () => {
    await setPolicy('in', 'static: red , green ');
    expect(await titlesFor(memberCookie)).toEqual(['alpha', 'beta']);
  });

  it('treats a single-value `in` as an equality', async () => {
    await setPolicy('in', 'static:green');
    expect(await titlesFor(memberCookie)).toEqual(['beta']);
  });

  it('survives cursor pagination', async () => {
    // The keyset branch re-implemented filter application and covered only the
    // six comparison operators, so `in` fell through its `else if` chain and
    // was never added to the query. The policy did not fail — it was simply
    // absent — and one query parameter was enough to leave it behind.
    await setPolicy('in', 'static:red,blue');

    // A cursor from before the first row, so the keyset branch is the one that
    // answers. `page` must stay 1 for the cursor path to engage.
    const cursor = Buffer.from(
      JSON.stringify({
        val: '1970-01-01T00:00:00.000Z',
        id: '00000000-0000-0000-0000-000000000000',
      }),
    ).toString('base64url');

    const res = await app.request(
      `/api/data/${COLLECTION}?cursor=${cursor}&sort=created_at&order=asc&limit=50`,
      { headers: { cookie: memberCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records?: Array<{ title: string }> };
    const titles = (body.records ?? []).map((r) => r.title).sort();

    // Same answer the offset path gives — `beta` (green) stays withheld.
    expect(titles).toEqual(['alpha', 'gamma']);
  });

  it('survives time travel', async () => {
    // `?as_of=` rebuilds rows from the JSON snapshots in zv_revisions instead
    // of selecting from the table, so the RLS injection never touched it. It
    // was tenant-scoped and column-masked, which made the answer look filtered
    // — and asking for a snapshot as of a second ago returned every row the
    // policy exists to withhold.
    await setPolicy('in', 'static:red,blue');

    const asOf = new Date(Date.now() + 60_000).toISOString();
    const res = await app.request(
      `/api/data/${COLLECTION}?as_of=${encodeURIComponent(asOf)}&limit=50`,
      { headers: { cookie: memberCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records?: Array<{ title: string }> };
    const titles = (body.records ?? []).map((r) => r.title).sort();

    // Same answer the live list gives — `beta` (green) stays withheld.
    expect(titles).toEqual(['alpha', 'gamma']);
  });

  it('a god sees every row — through a permission, not a role-name check', async () => {
    // This asserted the opposite until the override was redesigned. It used to
    // read `user.role === 'god'`, which never fired because `session.user.role`
    // is not populated, so gods were silently subject to RLS.
    //
    // The check is now `checkPermission(user.id, 'data', 'view_all')`, which
    // short-circuits for god users against the DATABASE role. Same outcome for
    // a god, but the power is now grantable to a named role and withholdable
    // from an operator who must administer without reading customer data — and
    // it cannot go stale the way a hardcoded string did.
    await setPolicy('in', 'static:red');
    expect(await titlesFor(godCookie)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('does not comma-split an `eq` value', async () => {
    // Splitting for every operator would break an `eq` policy whose value
    // legitimately contains a comma.
    await setPolicy('eq', 'static:red,blue');
    expect(await titlesFor(memberCookie)).toEqual([]);
  });
});
