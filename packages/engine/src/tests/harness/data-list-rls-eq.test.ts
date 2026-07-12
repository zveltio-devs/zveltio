/**
 * Phase C — list GET with RLS eq filter (handlers/list.ts RLS branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { invalidateRlsCache } from '../../lib/tenancy/rls.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hlrlse_${Date.now()}`;

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-list-eq-${Date.now()}@test.local`;
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
  const setCookie = signIn.headers.get('set-cookie') ?? '';
  const cookie = setCookie
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');

  return { cookie, userId };
}

d('data list RLS eq (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';
  let policyId = '';
  let openId = '';
  let otherId = '';

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
        description: 'only open bucket rows on list',
      }),
    });
    expect(policy.status).toBe(201);
    policyId = ((await policy.json()) as { policy: { id: string } }).policy.id;
    await invalidateRlsCache(COLLECTION);

    const post = (body: Record<string, string>) =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(body),
      });

    openId = ((await (await post({ title: 'open', bucket: 'open' })).json()) as { id: string }).id;
    otherId = (
      (await (await post({ title: 'other', bucket: 'restricted' })).json()) as {
        id: string;
      }
    ).id;
    expect(openId).toBeTruthy();
    expect(otherId).toBeTruthy();
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

  it('returns only rows matching RLS eq on list GET', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ id?: string; bucket?: string }>;
      pagination: { total: number };
    };
    const ids = body.records.map((r) => r.id);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(otherId);
    expect(body.records.every((r) => r.bucket === 'open')).toBe(true);
    expect(body.pagination.total).toBe(1);
  });
});
