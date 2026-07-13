/**
 * Phase C — time-travel list pagination slice (handlers/list.ts as_of branch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `httpg_${Date.now()}`;

d('data list time-travel pagination (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'seq', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
      ],
    } as never);

    for (let i = 1; i <= 5; i++) {
      await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ seq: i, label: `row-${i}` }),
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db
      .deleteFrom('zv_revisions')
      .where('collection', '=', COLLECTION)
      .execute()
      .catch(() => {});
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

  it('paginates reconstructed records for ?as_of= with page and limit', async () => {
    const asOf = encodeURIComponent(new Date().toISOString());
    const first = await app.request(
      `/api/data/${COLLECTION}?as_of=${asOf}&page=1&limit=2`,
      { headers: { cookie } },
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as {
      records: Array<{ id: string }>;
      pagination: { total: number; page: number; limit: number; pages: number };
    };
    expect(page1.records).toHaveLength(2);
    expect(page1.pagination.total).toBe(5);
    expect(page1.pagination.pages).toBe(3);

    const second = await app.request(
      `/api/data/${COLLECTION}?as_of=${asOf}&page=2&limit=2`,
      { headers: { cookie } },
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as { records: Array<{ id: string }> };
    expect(page2.records).toHaveLength(2);
    const page1Ids = new Set(page1.records.map((r) => r.id));
    expect(page2.records.every((r) => !page1Ids.has(r.id))).toBe(true);

    const third = await app.request(
      `/api/data/${COLLECTION}?as_of=${asOf}&page=3&limit=2`,
      { headers: { cookie } },
    );
    expect(third.status).toBe(200);
    const page3 = (await third.json()) as { records: Array<{ id: string }> };
    expect(page3.records).toHaveLength(1);
    const allIds = new Set([
      ...page1.records.map((r) => r.id),
      ...page2.records.map((r) => r.id),
      ...page3.records.map((r) => r.id),
    ]);
    expect(allIds.size).toBe(5);
  });
});
