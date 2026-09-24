/**
 * Row rules on the list route when two conditions name the SAME field.
 *
 * `GET /api/data/:collection` merged the row rules into the client's filter
 * map — `filters[field] = condition` — so one field could hold one condition.
 * Every other applier (`GET /:id`, PATCH/DELETE, bulk, sync, `?expand=`, the
 * realtime matcher, the generated Postgres policy) ANDs the whole list. Here:
 *
 *   - two rules on one field kept only the last, so the other rule's rows were
 *     listed. The generated Postgres policy ANDs both, but it binds only inside
 *     a tenant transaction (`SET role zveltio_rls`); without one — as here, and
 *     on a single-tenant instance — the engine is the only enforcer. The second
 *     case drops the policy so it keeps testing the engine if that changes.
 *   - a rule on a field the client filtered on replaced the client's
 *     condition, so the page answered a different question from the one asked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { ROW_RULE_POLICY } from '../../lib/tenancy/row-rule-policy.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlrlssf_${Date.now()}`;

type ListBody = { records: Array<{ title?: string }>; pagination: { total: number } };

d('data list — two row conditions on one field (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';
  const policyIds: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    const email = `harness-samefield-${Date.now()}@test.local`;
    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Member' }),
    });
    memberUserId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    expect(memberUserId).toBeTruthy();
    const enforcer = await getEnforcer();
    await enforcer.addPolicy(memberUserId, '*', COLLECTION, 'read');
    await invalidateUserPermCache(memberUserId);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    memberCookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const hidden of ['secret', 'draft']) {
      const res = await app.request('/api/admin/rls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify({
          collection: COLLECTION,
          role: '*',
          filter_field: 'bucket',
          filter_op: 'neq',
          filter_value_source: `static:${hidden}`,
        }),
      });
      expect(res.status).toBe(201);
      policyIds.push(((await res.json()) as { policy: { id: string } }).policy.id);
    }
    await invalidateRlsCache(COLLECTION);

    for (const bucket of ['open', 'secret', 'draft']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify({ title: bucket, bucket }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of policyIds) {
      await sql`DELETE FROM zvd_rls_policies WHERE id = ${id}::uuid`.execute(db).catch(() => {});
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

  const list = async (qs = '') => {
    const res = await app.request(`/api/data/${COLLECTION}${qs}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  };
  const titles = (b: ListBody) => b.records.map((r) => r.title).sort();

  // Runs first, with the generated policy in place.
  it("ANDs a rule with the client's filter on the same field", async () => {
    const filter = encodeURIComponent(JSON.stringify({ bucket: { eq: 'secret' } }));
    const body = await list(`?filter=${filter}`);
    expect(titles(body)).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it('applies BOTH rules on one field when the engine is the only enforcer', async () => {
    await sql.raw(`DROP POLICY IF EXISTS ${ROW_RULE_POLICY} ON "zvd_${COLLECTION}"`).execute(db);

    const offset = await list();
    expect(titles(offset)).toEqual(['open']);
    expect(offset.pagination.total).toBe(1);

    // The keyset branch builds its own query from the same conditions.
    const cursor = Buffer.from(
      JSON.stringify({ val: '', id: '00000000-0000-0000-0000-000000000000' }),
    ).toString('base64url');
    const keyset = await list(`?sort=title&order=asc&cursor=${cursor}`);
    expect(titles(keyset)).toEqual(['open']);
  });
});
