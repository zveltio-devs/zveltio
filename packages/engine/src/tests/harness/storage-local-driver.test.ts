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
    // Public upload → served over /files/* without a signature (the display-asset
    // path the range/serving assertions below exercise).
    fd.append('public', 'true');
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
    // Public upload lands under the public namespace and gets a bare /files URL.
    expect(storagePath.startsWith('public/')).toBe(true);
    expect(body.file.url).toContain('/files/');
  });

  it('GET /files/<key> serves the stored bytes', async () => {
    const res = await app.request(`/files/${storagePath}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('local-bytes-123');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('GET /files/<key> 404s an unknown object (public namespace)', async () => {
    const res = await app.request('/files/media/does-not-exist.txt');
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

d('storage local-driver — private files require a signature (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let privatePath = '';
  let signedRel = '';

  beforeAll(async () => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    delete process.env.STORAGE_DRIVER;
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const fd = new FormData();
    fd.append(
      'file',
      new File([new TextEncoder().encode('secret-hr-doc')], 'contract.txt', { type: 'text/plain' }),
    );
    // No `public` flag → private by default.
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    const body = (await res.json()) as { file: { storage_path: string; url?: string } };
    privatePath = body.file.storage_path;
    // A private upload lands OUTSIDE the public namespace and returns a signed URL.
    signedRel = (body.file.url ?? '').replace(/^https?:\/\/[^/]+/, '');
  });

  it('private upload is not under the public namespace and returns a signed URL', () => {
    expect(privatePath.startsWith('public/')).toBe(false);
    expect(privatePath.startsWith('media/')).toBe(false);
    expect(signedRel).toContain('sig=');
    expect(signedRel).toContain('exp=');
  });

  it('serving a private key WITHOUT a signature is 403 (P0: no bare-path access)', async () => {
    const res = await app.request(`/files/${privatePath}`);
    expect(res.status).toBe(403);
  });

  it('stripping ?exp&sig from the signed link is 403 (expiry cannot be bypassed)', async () => {
    const bare = signedRel.split('?')[0];
    const res = await app.request(bare);
    expect(res.status).toBe(403);
  });

  it('the signed link itself serves the bytes (200)', async () => {
    const res = await app.request(signedRel);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret-hr-doc');
  });
});
