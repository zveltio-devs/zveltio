/**
 * Both upload routes count against the same storage quota.
 *
 * `POST /api/media/files` and `POST /api/storage/upload` write the same rows to
 * the same `zv_media_files` table and draw on the same allowance. Only the
 * first checked it. The second enforced a per-FILE size limit, which answers a
 * different question: a user at their limit could keep uploading indefinitely
 * through the other endpoint as long as each file stayed under 50 MB.
 *
 * The quota is set to a few bytes here rather than filled up, because the bug
 * is about which door is guarded, not about how the total is computed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('storage quota applies to every upload route', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let userId = '';

  const upload = (path: string, name: string) => {
    const fd = new FormData();
    fd.set('file', new File(['x'.repeat(4096)], name, { type: 'text/plain' }));
    return app.request(path, { method: 'POST', headers: { cookie }, body: fd });
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const me = await (await app.request('/api/me', { headers: { cookie } })).json();
    userId = (me as { user: { id: string } }).user.id;

    // A quota smaller than the file being uploaded: anything at all is over.
    await sql`
      INSERT INTO zv_storage_quotas (user_id, quota_bytes, used_bytes)
      VALUES (${userId}, 16, 0)
      ON CONFLICT (user_id) DO UPDATE SET quota_bytes = 16
    `.execute(db);
  });

  afterAll(async () => {
    if (!db || !userId) return;
    await sql`DELETE FROM zv_storage_quotas WHERE user_id = ${userId}`.execute(db).catch(() => {});
  });

  it('refuses the media upload when the quota is exceeded', async () => {
    // The route that always checked — the control.
    const res = await upload('/api/media/upload', 'via-media.txt');
    expect(res.status).toBe(413);
  });

  it('refuses the storage upload too', async () => {
    // The bug: this returned 201 and wrote the row.
    const res = await upload('/api/storage/upload', 'via-storage.txt');
    expect(res.status).toBe(413);
    // Non-2xx under /api is rewrapped into the problem envelope, so the
    // message lands in `detail` rather than `error`.
    const body = (await res.json()) as { detail?: string; error?: string };
    expect(body.detail ?? body.error ?? '').toMatch(/quota/i);
  });
});
