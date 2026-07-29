/**
 * Admin storage config + test-connection (routes/admin/storage-routes.ts):
 * GET the effective config (secret masked), a local test-connection probe, an
 * unreachable-S3 probe, and a persist-then-reflect round-trip. The DB overlay
 * is reset afterwards so the shared harness app is unaffected.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { setStorageOverlay } from '../../lib/storage/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const TMP = mkdtempSync(join(tmpdir(), 'zv-store-admin-'));
const d = harnessAvailable() ? describe : describe.skip;

d('admin storage config (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    // Undo any persisted overlay so later tests see env-only config.
    setStorageOverlay({});
    await db
      .deleteFrom('zv_settings')
      .where('key', '=', 'storage_config')
      .execute()
      .catch(() => {});
    rmSync(TMP, { recursive: true, force: true });
  });

  it('GET /api/admin/storage/config returns the effective config, secret masked', async () => {
    const res = await app.request('/api/admin/storage/config', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { driver: string; s3: Record<string, unknown> };
    expect(['local', 's3']).toContain(body.driver);
    // The secret itself must never be returned — only a boolean flag.
    expect(body.s3).not.toHaveProperty('secretKey');
    expect(body.s3).toHaveProperty('secretKeySet');
  });

  it('POST /storage/test — local driver probe succeeds against a writable dir', async () => {
    const res = await app.request('/api/admin/storage/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ driver: 'local', localDir: TMP }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('POST /storage/test — s3 probe against an unreachable endpoint fails cleanly', async () => {
    const res = await app.request('/api/admin/storage/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        driver: 's3',
        s3: { endpoint: 'http://127.0.0.1:1', accessKey: 'x', secretKey: 'y', bucket: 'zveltio' },
      }),
    });
    expect(res.status).toBe(200); // the probe ran; verdict is in the body
    const body = (await res.json()) as { ok: boolean; detail: string };
    expect(body.ok).toBe(false);
    expect(typeof body.detail).toBe('string');
  });

  it('PUT /storage/config persists + applies; GET reflects it', async () => {
    const put = await app.request('/api/admin/storage/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ driver: 'local', localDir: TMP }),
    });
    expect(put.status).toBe(200);
    const get = await app.request('/api/admin/storage/config', { headers: { cookie } });
    const body = (await get.json()) as { driver: string; localDir: string };
    expect(body.driver).toBe('local');
    expect(body.localDir).toBe(TMP);
  });
});
