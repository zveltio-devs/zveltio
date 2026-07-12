/**
 * Phase C — LIST filter operators (neq, lt, in) via handlers/list + query-parse.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hfops_${Date.now()}`;

d('data list filter operators (in-process)', () => {
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
        { name: 'tier', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'low', score: 10, tier: 'a' },
      { label: 'mid', score: 50, tier: 'b' },
      { label: 'high', score: 90, tier: 'c' },
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
    records: Array<{ label: string; score: number; tier: string }>;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('filters with neq on a text field', async () => {
    const filter = JSON.stringify({ tier: { neq: 'b' } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.tier !== 'b')).toBe(true);
    expect(body.records.length).toBeGreaterThanOrEqual(2);
  });

  it('filters with lt on an integer field', async () => {
    const filter = JSON.stringify({ score: { lt: 50 } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.score < 50)).toBe(true);
    expect(body.records.some((r) => r.label === 'low')).toBe(true);
  });

  it('filters with in on a text field', async () => {
    const filter = JSON.stringify({ tier: { in: ['a', 'c'] } });
    const res = await list(`?filter=${encodeURIComponent(filter)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.tier === 'a' || r.tier === 'c')).toBe(true);
  });
});
