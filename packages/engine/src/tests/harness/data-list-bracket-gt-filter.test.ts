/**
 * Phase C — LIST bracket gt filter (?score[gt]=) via handlers/list.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbrgt_${Date.now()}`;

d('data list bracket gt filter (in-process)', () => {
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
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'low', score: 10 },
      { label: 'high', score: 40 },
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
    records: Array<{ label: string; score: number }>;
  }

  it('filters rows with score greater than 25 via bracket syntax', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?score[gt]=25`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.score > 25)).toBe(true);
    expect(body.records.some((r) => r.label === 'high')).toBe(true);
  });
});
