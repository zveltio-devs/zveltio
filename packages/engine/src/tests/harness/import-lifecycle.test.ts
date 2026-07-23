/**
 * Phase C — import routes: the multipart guards (non-multipart, missing file,
 * unsupported format, unknown collection) plus a real CSV import into a
 * provisioned collection, and the jobs listing. Drives routes/import.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `himp_${Date.now()}`;

d('import lifecycle (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_import_logs WHERE collection = ${COLLECTION}`
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
  });

  it('lists import jobs (GET /jobs)', async () => {
    const res = await app.request('/api/import/jobs', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('rejects a non-multipart body (POST /:collection)', async () => {
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ x: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing file field', async () => {
    const fd = new FormData();
    fd.set('format', 'csv');
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported format', async () => {
    const fd = new FormData();
    fd.set('file', new File(['title\nHi'], 'x.xlsx'));
    fd.set('format', 'xlsx');
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  it('404s importing into an unknown collection', async () => {
    const fd = new FormData();
    fd.set('file', new File(['title\nHi'], 'x.csv'));
    fd.set('format', 'csv');
    const res = await app.request('/api/import/does_not_exist_xyz', {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect(res.status).toBe(404);
  });

  it('imports a CSV into the collection', async () => {
    const fd = new FormData();
    fd.set('file', new File(['title\nAlpha\nBeta\nGamma'], 'data.csv', { type: 'text/csv' }));
    fd.set('format', 'csv');
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: fd,
    });
    expect([200, 201, 202]).toContain(res.status);
    const rows = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM ${sql.raw(`"zvd_${COLLECTION}"`)}`.execute(db);
    expect(rows.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });

  it('rejects unauthenticated import', async () => {
    const res = await app.request(`/api/import/${COLLECTION}`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
