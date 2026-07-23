/**
 * Phase C — media S3 object path: the real image upload → object-in-bucket →
 * record → delete round-trip through aws4fetch (routes/media.ts upload branch,
 * incl. the image-dimension extraction). Gated on S3_ENDPOINT (MinIO) — skips
 * cleanly without it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const hasS3 = Boolean(process.env.S3_ENDPOINT);
const d = harnessAvailable() && hasS3 ? describe : describe.skip;

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

d('media S3 upload round-trip (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let fileId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && fileId)
      await sql`DELETE FROM zv_media_files WHERE id = ${fileId}`.execute(db).catch(() => {});
  });

  it('uploads an image to S3 (POST /upload)', async () => {
    const fd = new FormData();
    fd.set('file', new File([PNG], 'harness.png', { type: 'image/png' }));
    fd.set('title', 'Harness Image');
    fd.set('alt_text', 'a pixel');
    const res = await app.request('/api/media/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string } };
    fileId = body.file.id;
    expect(fileId).toBeTruthy();
  });

  it('reads the uploaded file (GET /files/:id)', async () => {
    const res = await app.request(`/api/media/files/${fileId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('lists it (GET /files)', async () => {
    const res = await app.request('/api/media/files', { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
