/**
 * Reading the security record in bulk is itself an event on it.
 *
 * `GET /api/admin/audit/export` hands out up to 50 000 audit rows — every login
 * failure, every permission change, every god action on the instance, with the
 * acting user and address on each. It is the widest single read of the security
 * record there is, and it was the one privileged action that left no mark.
 *
 * `export.executed` already existed in the event union with no writer anywhere,
 * engine or extensions, so a reviewer filtering for it concluded no export had
 * ever happened.
 */
import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('the audit export records itself (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_audit_log WHERE event_type = 'export.executed'`.execute(db);
  });

  it('writes an export.executed entry carrying the filters that were used', async () => {
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'export.executed'
    `.execute(db);

    const res = await app.request('/api/admin/audit/export?event_type=god_action', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    const rows = await sql<{ metadata: unknown }>`
      SELECT metadata FROM zv_audit_log
       WHERE event_type = 'export.executed'
       ORDER BY created_at DESC LIMIT 1
    `.execute(db);
    expect(rows.rows.length).toBe(1);

    // Queryable, not a JSON string wrapped in quotes — the shape migration 041
    // exists to repair.
    const meta = rows.rows[0]!.metadata as Record<string, unknown>;
    const filters = meta.filters as Record<string, unknown>;
    expect(filters.event_type).toBe('god_action');
    expect(typeof meta.rows).toBe('number');
    expect(meta.truncated).toBe(false);

    const after = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'export.executed'
    `.execute(db);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
  });

  it('does not record a read that was refused', async () => {
    // Anonymous: the guard answers before the handler, so nothing is exported
    // and nothing should be written.
    const before = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'export.executed'
    `.execute(db);
    const res = await app.request('/api/admin/audit/export');
    expect([401, 403]).toContain(res.status);
    const after = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_audit_log WHERE event_type = 'export.executed'
    `.execute(db);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
