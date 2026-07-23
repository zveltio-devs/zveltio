/**
 * Phase C — backup routes: the real pg_dump → gzip create path, status
 * polling, download, delete, and PITR config get/patch. Exercises the
 * routes/backup.ts machinery that the list/config-only base test leaves
 * uncovered. Requires pg_dump + DATABASE_URL (set in the harness env).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

// pg_dump needs a connection URL. The harness sets TEST_DATABASE_URL; mirror it
// to DATABASE_URL (which the route parses) if not already present.
if (!process.env.DATABASE_URL && process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const canDump = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = harnessAvailable() && canDump ? describe : describe.skip;

async function poll(
  app: Hono,
  cookie: string,
  id: string,
  want: string,
  tries = 40,
): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const res = await app.request(`/api/backup/${id}/status`, { headers: { cookie } });
    if (res.status === 200) {
      const s = ((await res.json()) as { status: string }).status;
      if (s === want || s === 'failed') return s;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'timeout';
}

d('backup create/status/download (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let backupId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    if (db && backupId)
      await sql`DELETE FROM zv_backups WHERE id = ${backupId}`.execute(db).catch(() => {});
  });

  it('creates a backup (POST /) that pg_dump completes', async () => {
    const res = await app.request('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ notes: 'harness backup' }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { backup_id: string };
    backupId = body.backup_id;
    expect(backupId).toBeTruthy();

    const final = await poll(app, cookie, backupId, 'completed');
    expect(final).toBe('completed');
  });

  it('reports status (GET /:id/status)', async () => {
    const res = await app.request(`/api/backup/${backupId}/status`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('completed');
  });

  it('404s status for an unknown backup', async () => {
    const res = await app.request('/api/backup/00000000-0000-0000-0000-000000000000/status', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it('downloads the backup file (GET /:id/download)', async () => {
    const res = await app.request(`/api/backup/${backupId}/download`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
  });

  it('reads PITR config (GET /pitr/config)', async () => {
    const res = await app.request('/api/backup/pitr/config', { headers: { cookie } });
    expect([200, 404]).toContain(res.status);
  });

  it('updates PITR config (PATCH /pitr/config)', async () => {
    const res = await app.request('/api/backup/pitr/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ is_enabled: true, retention_days: 7 }),
    });
    expect([200, 201, 404]).toContain(res.status);
  });

  it('reports PITR status (GET /pitr/status)', async () => {
    const res = await app.request('/api/backup/pitr/status', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('deletes the backup (DELETE /:id)', async () => {
    const res = await app.request(`/api/backup/${backupId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(res.status);
    backupId = '';
  });
});
