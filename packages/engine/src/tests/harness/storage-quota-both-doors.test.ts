/**
 * Core storage upload enforces tenant quota.
 *
 * Historically `/api/media/upload` was a second door into the same
 * `zv_media_files` table; that dual door is gone (410 → content/media).
 * Quota for the remaining core upload path must still reject over-limit.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('storage quota on core upload', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let userId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const me = await (await app.request('/api/me', { headers: { cookie } })).json();
    userId = (me as { user: { id: string } }).user.id;

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

  it('refuses /api/storage/upload when the quota is exceeded', async () => {
    const fd = new FormData();
    fd.set('file', new File(['x'.repeat(4096)], 'via-storage.txt', { type: 'text/plain' }));
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { detail?: string; error?: string };
    expect(body.detail ?? body.error ?? '').toMatch(/quota/i);
  });
});
