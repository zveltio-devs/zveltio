/**
 * Full storage round-trip through the LOCAL driver (no S3): upload → stored on
 * disk → served by the engine's /files route → signed URL → transform → delete.
 * This is the path a self-hosted single-node install uses out of the box, and
 * the coverage the S3-only tests couldn't give without external infra.
 *
 * STORAGE_LOCAL_DIR is pointed at a temp dir before the app touches storage; the
 * driver reads it lazily per call, so the shared harness app picks it up.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const TMP = mkdtempSync(join(tmpdir(), 'zv-local-store-'));
const d = harnessAvailable() ? describe : describe.skip;

d('storage local-driver round-trip (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let fileId = '';
  let storagePath = '';

  beforeAll(async () => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    delete process.env.STORAGE_DRIVER; // default → local (no S3_ENDPOINT in harness)
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('POST /api/storage/upload stores the bytes on local disk', async () => {
    const fd = new FormData();
    fd.append(
      'file',
      new File([new TextEncoder().encode('local-bytes-123')], 'note.txt', { type: 'text/plain' }),
    );
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { file: { id: string; storage_path: string; url?: string } };
    fileId = body.file.id;
    storagePath = body.file.storage_path;
    expect(fileId).toBeTruthy();
    // url now points at the engine's /files route (local driver), not undefined.
    expect(body.file.url).toContain('/files/');
  });

  it('GET /files/<key> serves the stored bytes', async () => {
    const res = await app.request(`/files/${storagePath}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('local-bytes-123');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('GET /files/<key> 404s an unknown object', async () => {
    const res = await app.request('/files/uploads/2026/does-not-exist.txt');
    expect(res.status).toBe(404);
  });

  it('GET /files/<key> advertises Accept-Ranges on the full response', async () => {
    const res = await app.request(`/files/${storagePath}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('GET /files/<key> serves a byte range as 206 Partial Content', async () => {
    // 'local-bytes-123' → bytes 0-4 = 'local'
    const res = await app.request(`/files/${storagePath}`, { headers: { range: 'bytes=0-4' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/15');
    expect(res.headers.get('content-length')).toBe('5');
    expect(await res.text()).toBe('local');
  });

  it('GET /files/<key> honours an open-ended and a suffix range', async () => {
    const open = await app.request(`/files/${storagePath}`, { headers: { range: 'bytes=6-' } });
    expect(open.status).toBe(206);
    expect(await open.text()).toBe('bytes-123'); // bytes 6..end
    const suffix = await app.request(`/files/${storagePath}`, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe('123'); // last 3 bytes
  });

  it('GET /files/<key> rejects an unsatisfiable range with 416', async () => {
    const res = await app.request(`/files/${storagePath}`, {
      headers: { range: 'bytes=999-1000' },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */15');
  });

  it('GET /files/<key>.meta is never served (internal sidecar)', async () => {
    const res = await app.request(`/files/${storagePath}.meta`);
    expect(res.status).toBe(404);
  });

  it('GET /:id/signed-url yields an HMAC URL that /files accepts', async () => {
    const res = await app.request(`/api/storage/${fileId}/signed-url`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toContain('sig=');
    // The signed URL must actually serve (strip origin → request path+query).
    const rel = url.replace(/^https?:\/\/[^/]+/, '');
    const served = await app.request(rel);
    expect(served.status).toBe(200);
    // A tampered signature is rejected.
    const bad = await app.request(rel.replace(/sig=([0-9a-f]+)/, 'sig=$1deadbeef'));
    expect(bad.status).toBe(403);
  });

  it('DELETE /:id removes the record and the on-disk object', async () => {
    const res = await app.request(`/api/storage/${fileId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const gone = await app.request(`/files/${storagePath}`);
    expect(gone.status).toBe(404);
  });
});
