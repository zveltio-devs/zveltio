/**
 * Phase C — LIST sort desc + numeric range + not_in filters (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsort_${Date.now()}`;

d('data list sort desc and range filters (in-process)', () => {
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
        { name: 'score', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'bucket', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'a', score: 10, bucket: 'x' },
      { label: 'b', score: 30, bucket: 'y' },
      { label: 'c', score: 50, bucket: 'z' },
      { label: 'd', score: 70, bucket: 'x' },
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
    records: Array<{ label: string; score: number; bucket: string }>;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('sorts by score descending', async () => {
    const res = await list('?sort=score&order=desc');
    expect(res.status).toBe(200);
    const amounts = ((await res.json()) as ListBody).records.map((r) => r.score);
    const sorted = [...amounts].sort((a, b) => b - a);
    expect(amounts).toEqual(sorted);
    expect(amounts[0]).toBeGreaterThanOrEqual(50);
  });

  it('filters with lte on score', async () => {
    const filter = JSON.stringify({ score: { lte: 35 } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.score <= 35)).toBe(true);
    expect(body.records.some((r) => r.label === 'a')).toBe(true);
    expect(body.records.some((r) => r.label === 'b')).toBe(true);
  });

  it('filters with not_in on bucket', async () => {
    const filter = JSON.stringify({ bucket: { not_in: ['x', 'z'] } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.bucket !== 'x' && r.bucket !== 'z')).toBe(true);
    expect(body.records.some((r) => r.label === 'b')).toBe(true);
  });
});
