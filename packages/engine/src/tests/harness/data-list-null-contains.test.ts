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

  it('filters with in via bracket syntax — the documented form', async () => {
    // Bound as a string, `= ANY($1)` made PostgreSQL parse "alpha,gamma" as an
    // array literal and refuse the query.
    const res = await list('?label[in]=alpha,gamma');
    expect(res.status).toBe(200);
    const labels = ((await res.json()) as ListBody).records.map((r) => r.label).sort();
    expect(labels).toEqual(['alpha', 'gamma']);
  });

  it('filters with not_in holding a single value in JSON', async () => {
    const filter = JSON.stringify({ label: { not_in: 'beta' } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const labels = ((await res.json()) as ListBody).records.map((r) => r.label).sort();
    expect(labels).toEqual(['alpha', 'gamma']);
  });

  it('filters with like on code via bracket syntax', async () => {
    const res = await list('?code[like]=A-');
    expect(res.status).toBe(200);
    const labels = ((await res.json()) as ListBody).records.map((r) => r.label);
    expect(labels).toEqual(['alpha']);
  });

  it('treats % and _ in a like / contains value as literal characters', async () => {
    // Passed through, `_` matched any one character (`A_` matched `A-100`) and
    // `%` any run (`B%0` matched `B-200`).
    for (const qs of [
      '?code[like]=A_',
      `?code[like]=${encodeURIComponent('B%0')}`,
      `?filter=${encodeURIComponent(JSON.stringify({ code: { contains: '_' } }))}`,
      `?filter=${encodeURIComponent(JSON.stringify({ code: { ilike: '%' } }))}`,
    ]) {
      const res = await list(qs);
      expect(res.status).toBe(200);
      expect(((await res.json()) as ListBody).records).toEqual([]);
    }
  });
});
