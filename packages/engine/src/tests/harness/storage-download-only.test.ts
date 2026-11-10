/**
 * Any file type is stored; a type outside the inline allowlist is only ever
 * served as a download (ADR 0033).
 *
 * `/api/storage/upload` refused `.html`, `.ics`, `.eml` and every other type off
 * the allowlist, which mail attachments are. Now it stores them, and every path
 * that serves the bytes (the upload's own URL, `/:id/signed-url`, a public URL;
 * on the local driver all of them end at `/files`) answers octet-stream,
 * attachment, nosniff and a CSP sandbox. A `.png` whose bytes are HTML is not
 * an image either. On S3 the object's metadata says the same, which is what a
 * presigned link the engine did not sign (a share link) serves: `storage-s3`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const TMP = mkdtempSync(join(tmpdir(), 'zv-download-only-'));
const d = harnessAvailable() ? describe : describe.skip;

const HTML = '<html><body><script>parent.pwned=1</script></body></html>';
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

d('stored files outside the inline types are served only as downloads (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const ids: string[] = [];

  const upload = async (
    name: string,
    type: string,
    body: string | Uint8Array,
    isPublic = false,
  ): Promise<{ id: string; url: string; storage_path: string; mimetype: string }> => {
    const fd = new FormData();
    fd.append('file', new File([body], name, { type }));
    if (isPublic) fd.append('public', 'true');
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as {
      file: { id: string; url: string; storage_path: string; mimetype: string };
    };
    ids.push(file.id);
    return file;
  };
  /** GET a URL the engine handed out, on this app. */
  const open = (url: string) => {
    const u = new URL(url);
    return app.request(u.pathname + u.search);
  };
  const signed = async (id: string) => {
    const res = await app.request(`/api/storage/${id}/signed-url`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { url: string }).url;
  };
  const expectDownload = (res: Response, name: string) => {
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(res.headers.get('content-disposition')).toStartWith('attachment;');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
  };

  beforeAll(async () => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    delete process.env.STORAGE_DRIVER;
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && ids.length) {
      await sql`DELETE FROM zv_media_files WHERE id = ANY(${ids}::uuid[])`
        .execute(db)
        .catch(() => {});
    }
    rmSync(TMP, { recursive: true, force: true });
  });

  it('stores an .html file and serves it as a download on its URL and a signed URL', async () => {
    const f = await upload('page.html', 'text/html', HTML);
    expect(f.mimetype).toBe('text/html');
    expectDownload(await open(f.url), 'page.html');
    expectDownload(await open(await signed(f.id)), 'page.html');
  });

  it('serves a public .html upload as a download too', async () => {
    const f = await upload('landing.html', 'text/html', HTML, true);
    expect(f.storage_path).toStartWith('public/');
    expectDownload(await open(f.url), 'landing.html');
  });

  it('stores mail parts (.eml, .ics, no extension) under their own names', async () => {
    for (const name of ['message.eml', 'Invitație.ics', 'README']) {
      const f = await upload(name, 'application/octet-stream', 'x');
      expectDownload(await open(await signed(f.id)), name);
    }
  });

  it('does not serve a .png whose bytes are HTML as an image', async () => {
    const f = await upload('evil.png', 'image/png', HTML);
    expect(f.mimetype).toBe('application/octet-stream');
    expectDownload(await open(await signed(f.id)), 'evil.png');
  });

  it('still serves a real PNG inline', async () => {
    const f = await upload('pixel.png', 'image/png', PNG);
    const res = await open(await signed(f.id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('still sanitises an SVG and serves it inline under a sandbox', async () => {
    const f = await upload(
      'logo.svg',
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.x=1</script><circle r="4"/></svg>',
    );
    const res = await open(await signed(f.id));
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).toContain('circle');
  });
});
