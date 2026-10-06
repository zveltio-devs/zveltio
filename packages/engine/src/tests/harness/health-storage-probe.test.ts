/**
 * The storage health check probes the storage the engine actually uses.
 *
 * It read STORAGE_DIR, a variable nothing else reads: local storage is
 * configured by STORAGE_LOCAL_DIR (or its default) and by the Studio settings
 * overlay, both resolved by storageConfig(). So on a default install the check
 * answered `{ configured: false }` and ok — while uploads to an unwritable
 * directory failed — and S3 configured from Studio was never checked at all.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TMP = mkdtempSync(join(tmpdir(), 'zv-health-store-'));
const saved = { dir: process.env.STORAGE_LOCAL_DIR, driver: process.env.STORAGE_DRIVER };

d('health: storage probes the configured local directory (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  const probe = async () => {
    const res = await app.request('/api/health/storage', { headers: { cookie } });
    return {
      status: res.status,
      body: (await res.json()) as { ok: boolean; detail?: { dir?: string } },
    };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterEach(() => {
    if (saved.dir === undefined) delete process.env.STORAGE_LOCAL_DIR;
    else process.env.STORAGE_LOCAL_DIR = saved.dir;
    if (saved.driver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = saved.driver;
  });

  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it('reports a local directory it cannot write as not ok', async () => {
    // A regular file where the directory should be: unwritable even as root.
    const notADir = join(TMP, 'not-a-dir');
    writeFileSync(notADir, 'x');
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_DIR = notADir;
    const { status, body } = await probe();
    expect(body.ok).toBe(false);
    expect(status).toBe(503);
  });

  it('reports a writable local directory as ok, naming it', async () => {
    const dir = mkdtempSync(join(TMP, 'ok-'));
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_LOCAL_DIR = dir;
    const { status, body } = await probe();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.detail?.dir).toBe(dir);
  });
});
