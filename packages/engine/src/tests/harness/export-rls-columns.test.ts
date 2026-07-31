/**
 * Export honours RLS and column permissions.
 *
 * `/api/export/:collection` checked read on the COLLECTION and then selected
 * every row and every column. A user could export exactly the rows an RLS
 * policy hid and exactly the columns a column permission forbade — the same
 * data as the data API, through a different route.
 *
 * This is the shape the audit named: the main `/api/data` path is well
 * defended and the secondary paths lag behind it. A read boundary that only one
 * route honours is not a boundary.
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
const COLLECTION = `hexp_${Date.now()}`;

async function memberSession(app: Hono, db: Database): Promise<{ cookie: string; userId: string }> {
  const email = `harness-export-${Date.now()}@test.local`;
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

d('export honours RLS + column permissions (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';

  const exportJson = async (cookie: string): Promise<Array<Record<string, unknown>>> => {
    const res = await app.request(`/api/export/${COLLECTION}?format=json`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<Record<string, unknown>>;
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

    // Rows outside `open` are hidden from every non-god role.
    await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection: COLLECTION,
        role: '*',
        filter_field: 'bucket',
        filter_op: 'eq',
        filter_value_source: 'static:open',
        description: 'export rls',
      }),
    });
    await invalidateRlsCache(COLLECTION);

    // `salary` is forbidden to members.
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

  it('does not export rows an RLS policy hides', async () => {
    const rows = await exportJson(memberCookie);
    expect(rows.map((r) => r.title)).toEqual(['visible']);
  });

  it('does not export a column the role may not read', async () => {
    const rows = await exportJson(memberCookie);
    expect(rows[0]).toBeDefined();
    expect('salary' in rows[0]!).toBe(false);
    // The columns it IS entitled to must still be there — a fix that exported
    // nothing would pass a "does not leak" test while breaking the feature.
    expect(rows[0]!.title).toBe('visible');
    expect(rows[0]!.bucket).toBe('open');
  });

  it('CSV goes through the same filters, not just JSON', async () => {
    const res = await app.request(`/api/export/${COLLECTION}?format=csv`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('salary');
    expect(body).not.toContain('hidden');
    expect(body).toContain('visible');
  });
});
