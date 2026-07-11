/**
 * Phase C — /api/backup list + config (routes/backup.ts read paths only).
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('backup routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  it('GET /api/backup lists recent backup jobs', async () => {
    const res = await app.request('/api/backup', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backups: unknown[] };
    expect(Array.isArray(body.backups)).toBe(true);
  });

  it('GET /api/backup/config returns backup directory config', async () => {
    const res = await app.request('/api/backup/config', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backup_dir: string; max_backups: number };
    expect(typeof body.backup_dir).toBe('string');
    expect(body.max_backups).toBeGreaterThan(0);
  });

  it('rejects unauthenticated backup listing', async () => {
    const res = await app.request('/api/backup');
    expect([401, 403]).toContain(res.status);
  });
});
