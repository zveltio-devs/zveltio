/**
 * Phase C — /api/media/folders (routes/media.ts folder CRUD, no S3).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FOLDER = `h-folder-${Date.now()}`;

d('media folders (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let folderId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && folderId) {
      await db
        .deleteFrom('zv_media_folders')
        .where('id', '=', folderId)
        .execute()
        .catch(() => {});
    }
  });

  it('GET /api/media/folders lists folders', async () => {
    const res = await app.request('/api/media/folders', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: unknown[] };
    expect(Array.isArray(body.folders)).toBe(true);
  });

  it('POST /api/media/folders creates a folder', async () => {
    const res = await app.request('/api/media/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: FOLDER, description: 'harness media folder' }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { folder: { id: string; name: string } };
    folderId = body.folder.id;
    expect(body.folder.name).toBe(FOLDER);
  });

  it('rejects unauthenticated folder listing', async () => {
    const res = await app.request('/api/media/folders');
    expect(res.status).toBe(401);
  });
});
