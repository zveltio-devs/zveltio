/**
 * A colleague's private upload is not everyone's business.
 *
 * `GET /api/media/files` required a session and nothing else — no permission
 * check, no owner filter — so every authenticated user could list and download
 * every file anyone in the tenant had ever uploaded. On a Business OS for
 * companies and public institutions that is HR's scanned ID and finance's
 * payroll export, readable by anyone with a login.
 *
 * It was not obviously wrong because `zv_media_files` serves two purposes
 * through one table: a CMS asset library, which WANTS tenant-wide reach, and
 * personal storage, which does not. Migration 028 adds the distinction.
 *
 * Driven with two ordinary members, because a god or tenant admin is exempt by
 * design — they can already delete any file in the tenant, so hiding one from
 * a listing would be a lock on a door with no wall.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();

async function member(app: Hono, db: Database, tag: string) {
  const email = `harness-vis-${tag}-${STAMP}@test.local`;
  const password = 'MemberUser123!';
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: tag }),
  });
  const id = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
  await sql`UPDATE "user" SET role = 'member' WHERE id = ${id}`.execute(db);
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
  return { id, cookie };
}

d('media file visibility', () => {
  let app: Hono;
  let db: Database;
  let alice: { id: string; cookie: string };
  let bob: { id: string; cookie: string };
  let godCookie = '';
  const privateId = '00000000-0000-4000-8000-00000000ac01';
  const sharedId = '00000000-0000-4000-8000-00000000ac02';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    alice = await member(app, db, 'alice');
    bob = await member(app, db, 'bob');

    const insert = (id: string, visibility: string, name: string) =>
      sql`
      INSERT INTO zv_media_files
        (id, tenant_id, filename, original_name, mimetype, size, storage_path,
         created_by, visibility)
      VALUES (${id}::uuid, '00000000-0000-0000-0000-000000000001'::uuid,
              ${name}, ${name}, 'text/plain', 3, ${`uploads/${name}`},
              ${alice.id}, ${visibility})
    `.execute(db);

    await insert(privateId, 'personal', `payroll-${STAMP}.txt`);
    await insert(sharedId, 'tenant', `logo-${STAMP}.txt`);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_media_files WHERE id IN (${privateId}::uuid, ${sharedId}::uuid)`
      .execute(db)
      .catch(() => {});
    for (const u of [alice, bob]) {
      if (!u?.id) continue;
      await sql`DELETE FROM "session" WHERE "userId" = ${u.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM "account" WHERE "userId" = ${u.id}`.execute(db).catch(() => {});
      await sql`DELETE FROM "user" WHERE id = ${u.id}`.execute(db).catch(() => {});
    }
  });

  const listNames = async (cookie: string): Promise<string[]> => {
    const res = await app.request('/api/media/files?limit=200', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files?: { filename: string }[] };
    return (body.files ?? []).map((f) => f.filename);
  };

  it('shows the owner their own private file', async () => {
    expect(await listNames(alice.cookie)).toContain(`payroll-${STAMP}.txt`);
  });

  it('hides it from a colleague', async () => {
    // The bug, stated directly: this used to contain it.
    expect(await listNames(bob.cookie)).not.toContain(`payroll-${STAMP}.txt`);
  });

  it('still shows the shared library asset to that colleague', async () => {
    // Narrowing must not turn the asset library into a set of silos — an
    // editor uploads the logo so everyone can use it.
    expect(await listNames(bob.cookie)).toContain(`logo-${STAMP}.txt`);
  });

  it('answers 404 when a colleague names the private file directly', async () => {
    // Not 403: whether it exists is itself something the owner did not share.
    const res = await app.request(`/api/media/files/${privateId}`, {
      headers: { cookie: bob.cookie },
    });
    expect(res.status).toBe(404);
  });

  it('refuses a colleague a signed URL for it', async () => {
    // The listing is not the only way to reach the bytes.
    const res = await app.request(`/api/storage/${privateId}/signed-url`, {
      headers: { cookie: bob.cookie },
    });
    expect(res.status).toBe(404);
  });

  it('lets the owner fetch it directly', async () => {
    const res = await app.request(`/api/media/files/${privateId}`, {
      headers: { cookie: alice.cookie },
    });
    expect(res.status).toBe(200);
  });

  it('exempts a tenant admin', async () => {
    // They can already delete any file in the tenant; hiding one from a
    // listing would be a lock on a door with no wall.
    expect(await listNames(godCookie)).toContain(`payroll-${STAMP}.txt`);
  });
});
