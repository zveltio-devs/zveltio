/**
 * Phase C — storage S3 object path: the real upload → object-in-bucket →
 * record → delete round-trip through aws4fetch. Exercises the routes/storage.ts
 * S3 branch that the DB-only tests can't reach. Gated on S3_ENDPOINT (a MinIO
 * service in CI; a local MinIO binary in dev) — skips cleanly without it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const hasS3 = Boolean(process.env.S3_ENDPOINT);
const d = harnessAvailable() && hasS3 ? describe : describe.skip;

// A 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

d('storage S3 upload round-trip (in-process)', () => {
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

  it('uploads a file to S3 (POST /upload)', async () => {
    const fd = new FormData();
    fd.set('file', new File([PNG], 'pixel.png', { type: 'image/png' }));
    fd.set('title', 'Harness Pixel');
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string; url?: string } };
    fileId = body.file.id;
    expect(fileId).toBeTruthy();
  });

  it('reads the uploaded file record (GET /:id)', async () => {
    const res = await app.request(`/api/storage/${fileId}`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('lists the file (GET /)', async () => {
    const res = await app.request('/api/storage', { headers: { cookie } });
    expect(res.status).toBe(200);
    const files = ((await res.json()) as { files: Array<{ id: string }> }).files;
    expect(files.some((f) => f.id === fileId)).toBe(true);
  });

  it('deletes the file + its S3 object (DELETE /:id)', async () => {
    const res = await app.request(`/api/storage/${fileId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    fileId = '';
  });
});
