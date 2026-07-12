/**
 * Phase C — LIST bracket filter syntax (?amount[gte]=) through handlers/list.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbrkt_${Date.now()}`;

d('data list bracket filters (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'amount', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (const [title, amount] of [
      ['low', 5],
      ['high', 50],
    ] as const) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title, amount }),
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
    records: Array<{ title: string; amount: number }>;
  }

  it('filters with bracket syntax amount[gte]=40', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?amount[gte]=40`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.records.every((r) => r.amount >= 40)).toBe(true);
    expect(body.records.some((r) => r.title === 'high')).toBe(true);
  });

  it('returns 400 for an unknown sort column', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?sort=not_a_field`, {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });
});
