/**
 * Phase C — storage routes (DB-metadata surface): file listing, folder
 * list/create, the upload + folder-name guards, and detail 404. The S3
 * object path is integration/soak territory. Drives routes/storage.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('storage files/folders (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let folderId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && folderId)
      await sql`DELETE FROM zv_media_folders WHERE id = ${folderId}`.execute(db).catch(() => {});
  });

  it('lists files (GET /)', async () => {
    const res = await app.request('/api/storage', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { files: unknown[] }).files)).toBe(true);
  });

  it('lists folders (GET /folders)', async () => {
    const res = await app.request('/api/storage/folders', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('creates a folder (POST /folders)', async () => {
    const res = await app.request('/api/storage/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `hstor-${Date.now()}` }),
    });
    expect(res.status).toBe(201);
    folderId = ((await res.json()) as { folder: { id: string } }).folder.id;
    expect(folderId).toBeTruthy();
  });

  it('rejects a folder with no name (POST /folders)', async () => {
    const res = await app.request('/api/storage/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an upload with no file (POST /upload)', async () => {
    const fd = new FormData();
    fd.set('title', 'x');
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect([400, 413, 502]).toContain(res.status);
  });

  it('404s an unknown file (GET /:id)', async () => {
    const res = await app.request('/api/storage/00000000-0000-0000-0000-000000000000', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated file listing', async () => {
    const res = await app.request('/api/storage');
    expect(res.status).toBe(401);
  });
});
