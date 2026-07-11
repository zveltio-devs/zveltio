/**
 * Phase C — /api/export and /api/import (routes/export.ts, routes/import.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hexp_${Date.now()}`;

d('export + import routes (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'qty', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);
    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Alpha', qty: 3 }),
    });
    await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'Beta', qty: 7 }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('GET /api/export/:collection?format=json returns records', async () => {
    const res = await app.request(`/api/export/${COLLECTION}?format=json&limit=10`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/export/:collection?format=csv returns text/csv', async () => {
    const res = await app.request(`/api/export/${COLLECTION}?format=csv&limit=10`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('title');
    expect(text).toContain('Alpha');
  });

  it('GET /api/import/jobs lists recent import logs for admins', async () => {
    const res = await app.request('/api/import/jobs', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  it('POST /api/import/:collection ingests JSON rows', async () => {
    const payload = JSON.stringify([{ title: 'Imported', qty: 99 }]);
    const form = new FormData();
    form.append('file', new Blob([payload], { type: 'application/json' }), 'rows.json');
    form.append('format', 'json');
    const res = await app.request(`/api/import/${COLLECTION}`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
    expect([200, 201, 202]).toContain(res.status);
    const list = await app.request(`/api/data/${COLLECTION}?filter[title][eq]=Imported`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { records: Array<{ title: string }> };
    expect(body.records.some((r) => r.title === 'Imported')).toBe(true);
  });
});
