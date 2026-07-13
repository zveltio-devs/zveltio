/**
 * Phase C — ascending cursor keyset with lte filter (handlers/list.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hclte_${Date.now()}`;

d('data list cursor asc + lte filter (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'rank', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
      ],
    } as never);

    for (const row of [
      { rank: 5, label: 'a' },
      { rank: 15, label: 'b' },
      { rank: 25, label: 'c' },
      { rank: 35, label: 'd' },
      { rank: 45, label: 'e' },
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
    records: Array<{ id: string; rank: number }>;
    next_cursor: string | null;
  }

  const list = (qs: string) => app.request(`/api/data/${COLLECTION}${qs}`, { headers: { cookie } });

  it('paginates ascending with cursor while lte filter is active', async () => {
    const filter = encodeURIComponent(JSON.stringify({ rank: { lte: 30 } }));
    const first = (await (
      await list(`?limit=2&sort=rank&order=asc&filter=${filter}`)
    ).json()) as ListBody;
    expect(first.records.every((r) => r.rank <= 30)).toBe(true);
    expect(first.next_cursor).toBeTruthy();

    const second = await list(
      `?limit=2&sort=rank&order=asc&filter=${filter}&cursor=${encodeURIComponent(first.next_cursor!)}`,
    );
    expect(second.status).toBe(200);
    const page2 = (await second.json()) as ListBody;
    expect(page2.records.every((r) => r.rank <= 30)).toBe(true);
    if (page2.records.length > 0) {
      expect(page2.records[0]!.rank).toBeGreaterThan(first.records[1]!.rank);
    }
  });
});
