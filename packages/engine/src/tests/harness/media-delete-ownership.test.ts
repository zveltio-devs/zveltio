/**
 * Deleting a file requires owning it.
 *
 * The media router requires only a session, and `moveToTrash` filters by id,
 * `deleted_at` and tenant — no owner check anywhere on the delete path. Any
 * authenticated user could trash any file in their tenant by naming its id.
 *
 * The same file has owner-or-admin checks on other operations (folder rename,
 * file update), so this was the one path that missed the rule the rest of the
 * module already follows — which is why it survived: it looks like the others.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const OWNER_FILE = '00000000-0000-4000-8000-0000000000c1';
const ROOT_TENANT = '00000000-0000-0000-0000-000000000001';

d('media delete ownership (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let intruderCookie = '';
  let intruderId = '';
  let ownerId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    // A second, ordinary user in the same tenant — the intruder.
    const email = `media-intruder-${STAMP}@test.local`;
    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Intruder' }),
    });
    intruderId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    await sql`UPDATE "user" SET role = 'member' WHERE id = ${intruderId}`.execute(db);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    intruderCookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((x) => x.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');

    // A file owned by someone else entirely.
    ownerId = crypto.randomUUID();
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", role, "createdAt", "updatedAt", "twoFactorEnabled")
      VALUES (${ownerId}, 'Owner', ${`media-owner-${STAMP}@test.local`}, true, 'member', NOW(), NOW(), false)
    `.execute(db);
    // Clear any row left by a previous run: ON CONFLICT DO NOTHING over an
    // already-trashed row would make the admin case 404 for the wrong reason.
    await sql`DELETE FROM zv_media_files WHERE id = ${OWNER_FILE}::uuid`.execute(db);
    await sql`
      INSERT INTO zv_media_files (id, filename, original_name, mimetype, size, storage_path, created_by, tenant_id)
      VALUES (${OWNER_FILE}::uuid, ${`f-${STAMP}.png`}, 'photo.png', 'image/png', 10,
              ${`uploads/f-${STAMP}.png`}, ${ownerId}, ${ROOT_TENANT}::uuid)
      ON CONFLICT (id) DO NOTHING
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_media_files WHERE id = ${OWNER_FILE}::uuid`
      .execute(db)
      .catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${ownerId}`.execute(db).catch(() => {});
    await sql`DELETE FROM "user" WHERE id = ${intruderId}`.execute(db).catch(() => {});
  });

  const stillThere = async (): Promise<boolean> => {
    const r = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM zv_media_files
      WHERE id = ${OWNER_FILE}::uuid AND deleted_at IS NULL
    `.execute(db);
    return Number(r.rows[0]!.n) === 1;
  };

  it("refuses to delete another user's file", async () => {
    const res = await app.request(`/api/media/files/${OWNER_FILE}`, {
      method: 'DELETE',
      headers: { cookie: intruderCookie },
    });
    expect(res.status).toBe(403);
    expect(await stillThere()).toBe(true);
  });

  it('refuses through the batch route too', async () => {
    // Without the same rule here, batch-delete was simply the easier way to do
    // what the single route now refuses.
    const res = await app.request('/api/media/files/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: intruderCookie },
      body: JSON.stringify({ ids: [OWNER_FILE] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; refused: number };
    expect(body.deleted).toBe(0);
    expect(body.refused).toBe(1);
    expect(await stillThere()).toBe(true);
  });

  it('lets an admin delete it', async () => {
    // The rule is owner-or-admin, not owner-only — a gate that blocked admins
    // would satisfy the refusals above while breaking moderation.
    //
    // This asserted 404 until the `numUpdatedRows` bug behind it was found:
    // the write SUCCEEDED and the route reported failure, because the Bun SQL
    // dialect returns 0n whether or not rows were updated.
    const res = await app.request(`/api/media/files/${OWNER_FILE}`, {
      method: 'DELETE',
      headers: { cookie: godCookie },
    });
    expect(res.status).toBe(200);
    expect(await stillThere()).toBe(false);
  });
});
