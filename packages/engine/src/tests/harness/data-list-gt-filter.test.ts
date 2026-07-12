/**
 * Phase C — LIST gt filter (handlers/list + dynamic.ts buildCondition).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgt_${Date.now()}`;

d('data list gt filter (in-process)', () => {
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
        { name: 'amount', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { label: 'low', amount: 5 },
      { label: 'mid', amount: 50 },
      { label: 'high', amount: 95 },
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

  it('filters with gt on an integer field via bracket syntax', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?amount[gt]=40`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: Array<{ label: string; amount: number }>;
    };
    expect(body.records.every((r) => r.amount > 40)).toBe(true);
    expect(body.records.some((r) => r.label === 'high')).toBe(true);
    expect(body.records.some((r) => r.label === 'mid')).toBe(true);
  });
});
