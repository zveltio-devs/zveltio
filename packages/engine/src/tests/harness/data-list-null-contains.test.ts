/**
 * Phase C — LIST null / contains / like filters (handlers/list + query-parse).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hnull_${Date.now()}`;

d('data list null and text filters (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
        { name: 'code', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'alpha', note: 'has-note', code: 'A-100' },
      { label: 'beta', note: null, code: 'B-200' },
      { label: 'gamma', note: 'another-note', code: null },
    ]) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(row),
      });
    }
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

  interface ListBody {
    records: Array<{ label: string; note: string | null; code: string | null }>;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('filters with is_null on an optional text field', async () => {
    const filter = JSON.stringify({ note: { is_null: true } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.note == null)).toBe(true);
    expect(body.records.some((r) => r.label === 'beta')).toBe(true);
  });

  it('filters with is_not_null on an optional text field', async () => {
    const filter = JSON.stringify({ code: { is_not_null: true } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.code != null)).toBe(true);
    expect(body.records.length).toBeGreaterThanOrEqual(2);
  });

  it('filters with contains on label', async () => {
    const filter = JSON.stringify({ label: { contains: 'amm' } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.label.toLowerCase().includes('amm'))).toBe(true);
    expect(body.records.some((r) => r.label === 'gamma')).toBe(true);
  });

  it('filters with like on code via bracket syntax', async () => {
    const res = await list('?code[like]=A-%');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => (r.code ?? '').startsWith('A-'))).toBe(true);
  });
});
