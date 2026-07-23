/**
 * Phase C — media routes: the folder patch/delete, files list + 404, and the
 * upload guard that the base media-folders test leaves uncovered. DB-metadata
 * surface only; the S3 object path is integration/soak territory.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('media files + folder mutations (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let folderId = '';

  const json = (method: string, body: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const res = await app.request(
      '/api/media/folders',
      json('POST', { name: `hmf-${Date.now()}` }),
    );
    folderId = ((await res.json()) as { folder: { id: string } }).folder.id;
  });

  afterAll(async () => {
    if (db && folderId)
      await sql`DELETE FROM zv_media_folders WHERE id = ${folderId}`.execute(db).catch(() => {});
  });

  it('renames a folder (PUT /folders/:id)', async () => {
    const res = await app.request(
      `/api/media/folders/${folderId}`,
      json('PUT', { name: 'Renamed Media' }),
    );
    expect([200, 204]).toContain(res.status);
  });

  it('404s updating an unknown folder', async () => {
    const res = await app.request(
      '/api/media/folders/00000000-0000-0000-0000-000000000000',
      json('PUT', { name: 'x' }),
    );
    expect(res.status).toBe(404);
  });

  it('lists files (GET /files)', async () => {
    const res = await app.request('/api/media/files', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('404s an unknown file (GET /files/:id)', async () => {
    const res = await app.request('/api/media/files/00000000-0000-0000-0000-000000000000', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('rejects an upload with no file (POST /upload)', async () => {
    const fd = new FormData();
    fd.set('title', 'x');
    const res = await app.request('/api/media/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect([400, 413, 502]).toContain(res.status);
  });

  it('deletes the folder (DELETE /folders/:id)', async () => {
    const res = await app.request(`/api/media/folders/${folderId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    folderId = '';
  });
});
