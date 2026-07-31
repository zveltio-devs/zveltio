/**
 * Sync pull honours RLS and column permissions.
 *
 * The push path applies RLS (it caches filters per collection and runs them on
 * every write). Pull selected every changed row with `selectAll()` and no
 * filters at all, so an offline client synced exactly the rows a policy hides
 * and the columns a role may not read — and then kept them on the device, where
 * no server-side check applies afterwards.
 *
 * `checkPermission(user, 'data:<collection>', 'read')` guarded the pull, but
 * that is collection-level and cannot see rows or columns. Same shape as the
 * export route: the main data path is defended, the secondary one is not.
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
const COLLECTION = `hsyncrls_${Date.now()}`;

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-sync-${Date.now()}@test.local`;
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
  await enforcer.addPolicy(userId, '*', `data:${COLLECTION}`, 'read');
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

d('sync pull honours RLS + column permissions (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';

  const pull = async (cookie: string) => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ collections: [`zvd_${COLLECTION}`], since: 0 }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { changes: Array<{ data?: Record<string, unknown> }> };
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
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    const post = (body: Record<string, string>) =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: godCookie },
        body: JSON.stringify(body),
      });
    await post({ title: 'visible', bucket: 'open', salary: '100' });
    await post({ title: 'hidden', bucket: 'restricted', salary: '200' });

    await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
        description: 'sync pull rls',
      }),
    });
    await invalidateRlsCache(COLLECTION);

    await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection_name: COLLECTION,
        column_name: 'salary',
        role: 'member',
        can_read: false,
        can_write: false,
      }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    if (memberUserId) {
      const enforcer = await getEnforcer();
      await enforcer.removePolicy(memberUserId, '*', COLLECTION, 'read').catch(() => {});
      await enforcer.removePolicy(memberUserId, '*', `data:${COLLECTION}`, 'read').catch(() => {});
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

  it('does not pull rows an RLS policy hides', async () => {
    const body = await pull(memberCookie);
    const titles = body.changes.map((ch) => ch.data?.title).filter(Boolean);
    expect(titles).not.toContain('hidden');
  });

  it('does not pull a column the role may not read', async () => {
    const body = await pull(memberCookie);
    for (const ch of body.changes) {
      expect(ch.data && 'salary' in ch.data).toBe(false);
    }
  });

  it('still pulls what the member is entitled to', async () => {
    // A fix that pulled nothing would satisfy both tests above while breaking
    // offline sync entirely.
    const body = await pull(memberCookie);
    const titles = body.changes.map((ch) => ch.data?.title).filter(Boolean);
    expect(titles).toContain('visible');
  });
});
