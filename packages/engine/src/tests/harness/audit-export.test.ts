/**
 * Audit-log date range + CSV export (TECHNICAL-GAPS 2.2).
 *
 * The CSV escaping in particular is regression-prone: a `Date` is `typeof
 * 'object'`, so a naive `JSON.stringify` branch double-quotes it and every
 * timestamp lands in the spreadsheet as """2026-…""". That shipped once during
 * development and is caught here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('audit log — range + CSV export', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  const MARKER = `audit.test.${Date.now()}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // Two rows far apart so the range filter has something to exclude. metadata
    // carries a quote + comma — the exact CSV-escaping hazard.
    await sql`
      INSERT INTO zv_audit_log (event_type, resource_type, resource_id, ip, metadata, created_at)
      VALUES
        (${MARKER}, 'test', 'old', '1.2.3.4', ${JSON.stringify({ note: 'say "hi", ok' })}::jsonb, '2020-03-15T10:00:00Z'),
        (${MARKER}, 'test', 'new', '5.6.7.8', '{}'::jsonb, '2020-06-01T09:00:00Z')
    `.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zv_audit_log WHERE event_type = ${MARKER}`.execute(db).catch(() => {});
  });

  it('filters by date range (excludes rows outside it)', async () => {
    const res = await app.request(
      `/api/admin/audit?event_type=${MARKER}&from=2020-03-01&to=2020-03-31`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit: Array<{ resource_id: string }> };
    expect(body.audit).toHaveLength(1);
    expect(body.audit[0]!.resource_id).toBe('old');
  });

  it('a bare `to` date covers the whole day', async () => {
    const res = await app.request(
      `/api/admin/audit?event_type=${MARKER}&from=2020-06-01&to=2020-06-01`,
      { headers: { Cookie: cookie } },
    );
    const body = (await res.json()) as { audit: unknown[] };
    // 09:00 on the `to` day must be included — not cut off at 00:00.
    expect(body.audit).toHaveLength(1);
  });

  it('exports CSV with correct headers and un-mangled timestamps', async () => {
    const res = await app.request(`/api/admin/audit/export?event_type=${MARKER}`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('X-Zveltio-Row-Count')).toBe('2');

    const csv = await res.text();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('created_at,event_type,user_id,resource_type,resource_id,ip,metadata');
    // Timestamp is single-quoted ISO, NOT the """…""" double-encoded form.
    expect(csv).toMatch(/"2020-0[36]-\d{2}T[\d:.]+Z"/);
    expect(csv).not.toContain('"""2020');
    // JSONB metadata is CSV-escaped by doubling its quotes, so the embedded
    // comma in `say "hi", ok` stays inside one cell instead of splitting it.
    expect(csv).toContain('""note""');
    expect(csv.trim().split('\n')).toHaveLength(3); // header + 2 rows, not 4
  });

  it('requires admin', async () => {
    const res = await app.request('/api/admin/audit/export');
    expect(res.status).toBe(401);
  });
});
