/**
 * A cursor walk keeps `?search=`. The keyset branch applied the filters and
 * row rules but not the search, so page 1 (offset) was searched and every page
 * after it answered unsearched rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcurs_${Date.now()}`;

d('data list cursor walk keeps ?search= (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const matching: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 9; i++) {
      const title = i % 3 === 0 ? `zebra number ${i}` : `lion number ${i}`;
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      if (title.startsWith('zebra')) matching.push(((await res.json()) as { id: string }).id);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  it('serves only matching rows on every page', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await app.request(`/api/data/${COLLECTION}?limit=1&order=asc&search=zebra${c}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { records: { id: string }[]; next_cursor: string | null };
      seen.push(...body.records.map((r) => r.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(matching);
  });
});
