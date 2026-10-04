/**
 * An uploaded SVG served from /files carries a sandboxing CSP.
 *
 * /files is the engine's own origin, the one Studio and its session cookie live
 * on. An SVG opened there directly is a document, not an image, and the only
 * thing between its content and that origin was the upload-time sanitizer. The
 * CSP is the second layer: whatever the sanitizer misses cannot script.
 * Other types keep their behaviour — `sandbox` would break the browser's PDF
 * viewer, and an image or text body cannot script.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const TMP = mkdtempSync(join(tmpdir(), 'zv-svg-csp-'));
const d = harnessAvailable() ? describe : describe.skip;

d('/files serves an SVG under a sandboxing CSP (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const upload = async (name: string, type: string, body: string): Promise<string> => {
    const fd = new FormData();
    fd.append('file', new File([new TextEncoder().encode(body)], name, { type }));
    fd.append('public', 'true');
    const res = await app.request('/api/storage/upload', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { file: { storage_path: string } }).file.storage_path;
  };

  beforeAll(async () => {
    process.env.STORAGE_LOCAL_DIR = TMP;
    delete process.env.STORAGE_DRIVER;
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('adds default-src none and sandbox to an SVG response', async () => {
    const key = await upload(
      'circle.svg',
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>',
    );
    const res = await app.request(`/files/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
  });

  it('leaves a text file without the sandbox', async () => {
    const key = await upload('note.txt', 'text/plain', 'plain');
    const res = await app.request(`/files/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy') ?? '').not.toContain('sandbox');
  });
});
