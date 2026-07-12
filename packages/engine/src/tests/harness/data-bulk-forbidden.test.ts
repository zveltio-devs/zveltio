/**
 * Phase C — checkAccess forbidden on bulk handlers (handlers/bulk.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbforb_${Date.now()}`;

async function createLimitedSession(app: Hono): Promise<string> {
  const email = `harness-bulk-limited-${Date.now()}@test.local`;
  const password = 'LimitedUser123!';

  await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Bulk Limited' }),
  });

  const signIn = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = signIn.headers.get('set-cookie') ?? '';
  return setCookie
    .split(',')
    .map((c) => c.split(';')[0]!.trim())
    .filter(Boolean)
    .join('; ');
}

d('data bulk forbidden (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let limitedCookie = '';
  let recordId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    limitedCookie = await createLimitedSession(app);

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'seed' }),
    });
    expect(create.status).toBe(201);
    recordId = ((await create.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (!db) return;
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

  it('returns 403 on bulk POST without collection create access', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: limitedCookie },
      body: JSON.stringify({ records: [{ title: 'bulk-row' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 on bulk PATCH without collection update access', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: limitedCookie },
      body: JSON.stringify({ records: [{ id: recordId, title: 'changed' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 on bulk DELETE without collection delete access', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie: limitedCookie },
      body: JSON.stringify({ ids: [recordId] }),
    });
    expect(res.status).toBe(403);
  });
});
