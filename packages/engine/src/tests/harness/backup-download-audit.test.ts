/**
 * Downloading a backup leaves a trace, and does not read the archive into RAM.
 *
 * `backup.created` and `backup.deleted` were both audited; the export — the one
 * action that carries a dump of every tenant out of the instance — was not. An
 * operator reading the trail could see that a backup existed and that it was
 * later removed, never that a copy had been taken. `backup.downloaded` was
 * already declared in `AuditEventType` — nothing had ever written it.
 *
 * The body is also the file itself now rather than an `arrayBuffer()` of it, so
 * the test asserts the bytes arrive intact; a 4 GB dump cannot be asserted on
 * here, but the shape that would have needed 4 GB of heap is gone.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('GET /api/backup/:id/download', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const dir = process.env.BACKUP_DIR || '/tmp/zveltio-backups';
  const filename = `zveltio-test-${Date.now()}.sql.gz`;
  const body = 'not really gzip, but bytes all the same';
  let id: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await Bun.write(`${dir}/${filename}`, body);
    const row = await sql<{ id: string }>`
      INSERT INTO zv_backups (filename, status, size_bytes, created_at, completed_at)
      VALUES (${filename}, 'completed', ${body.length}, NOW(), NOW())
      RETURNING id::text
    `.execute(db);
    id = row.rows[0].id;
  });

  it('serves the archive and records the export in the audit log', async () => {
    const res = await app.request(`/api/backup/${id}/download`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(filename);
    expect(await res.text()).toBe(body);

    const audit = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM zv_audit_log
      WHERE event_type = 'backup.downloaded' AND resource_id = ${id}
    `.execute(db);
    expect(Number(audit.rows[0].n)).toBe(1);
  });
});
