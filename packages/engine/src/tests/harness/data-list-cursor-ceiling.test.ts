/**
 * ADR 0021: a cursor page reads at most LIST_REFILL_ROUNDS batches. A caller
 * who saw one row of a large table read the whole table in one request; now the
 * walk stops at the ceiling with a short (here empty) page and a sealed cursor
 * at the last row it READ — a row the caller may not see, which the cursor does
 * not show — and the next request goes on from there. Stopping inside a NULL
 * run, inside ties or exactly at the ceiling must still serve every visible row
 * once, in order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { LIST_REFILL_ROUNDS } from '../../lib/data/handlers/list.js';
import { openCursor } from '../../lib/data/query-parse.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcurc_${Date.now()}`;
const OWNER = 'harness-cursor-ceiling';
// limit=1 reads one row per batch, so one request reads LIST_REFILL_ROUNDS rows.
const ROWS = LIST_REFILL_ROUNDS * 6;
// Row 10 is the LAST row the ceiling lets the first keyset request read. No
// visible row has a NULL rank, so the 20-row NULL run is hidden end to end.
const VISIBLE = new Set([0, LIST_REFILL_ROUNDS, 21, 22, 40]);

interface Row {
  id: string;
  rank: number | null;
  visible: boolean;
}
interface Page {
  records: { id: string }[];
  pagination: { total?: number };
  next_cursor: string | null;
}

d('data list cursor page has a read ceiling (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const rows: Row[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'rank', type: 'integer', required: false, unique: false, indexed: false },
      ],
    } as never);
    for (let i = 0; i < ROWS; i++) {
      // NULL runs and ties, so a ceiling stop lands inside both.
      const rank = i % 3 === 2 ? null : i % 4;
      const visible = VISIBLE.has(i);
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label: visible ? `show${i}` : `hide${i}`, rank }),
      });
      expect(res.status).toBe(201);
      rows.push({ id: ((await res.json()) as { id: string }).id, rank, visible });
    }
    entityAccessRegistry.scope(OWNER).register({
      table: `zvd_${COLLECTION}`,
      check: (record, _user, op) =>
        op === 'view' && String((record as { label: string }).label).startsWith('hide')
          ? 'deny'
          : 'allow',
    });
  });

  afterAll(async () => {
    entityAccessRegistry.unregisterAll(OWNER);
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  async function walk(qs: string): Promise<Page[]> {
    const pages: Page[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 60; i++) {
      const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await app.request(`/api/data/${COLLECTION}?${qs}${c}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      pages.push(body);
      // No cursor carries a row id in the clear, hidden or not.
      if (body.next_cursor) {
        const text = Buffer.from(body.next_cursor, 'base64url').toString('latin1');
        for (const r of rows) expect(text).not.toContain(r.id);
      }
      cursor = body.next_cursor;
      if (!cursor) return pages;
    }
    throw new Error('cursor walk did not end');
  }
  const served = (pages: Page[]) => pages.flatMap((p) => p.records.map((r) => r.id));

  it('stops each request at the ceiling and still reaches every visible row', async () => {
    const pages = await walk('limit=1&order=asc');
    expect(served(pages)).toEqual(rows.filter((r) => r.visible).map((r) => r.id));
    // Offset page 1 (row 0); row 10, read last under the ceiling; rows 11..20
    // hidden: an empty page, total unknown, a cursor at row 20; 21; 22; 23..32
    // hidden; 40; 41..50 hidden; 51..59 run out under the ceiling: the end.
    // Without the ceiling no page but the last was empty.
    expect(pages.map((p) => p.records.length)).toEqual([1, 1, 0, 1, 1, 0, 1, 0, 0]);
    expect(pages[2]!.next_cursor).not.toBeNull();
    expect(pages[2]!.pagination.total).toBeUndefined();
  });

  // Postgres: ASC puts NULLs last, DESC first; `id` breaks ties both ways.
  const ordered = (dir: 'asc' | 'desc') =>
    [...rows].sort((a, b) => {
      const s = dir === 'asc' ? 1 : -1;
      if (a.rank !== b.rank) {
        if (a.rank === null) return s;
        if (b.rank === null) return -s;
        return (a.rank - b.rank) * s;
      }
      return (a.id < b.id ? -1 : 1) * s;
    });

  for (const dir of ['asc', 'desc'] as const) {
    for (const limit of [1, 2]) {
      it(`sort=rank ${dir} limit=${limit}: every visible row once, in order`, async () => {
        const pages = await walk(`limit=${limit}&sort=rank&order=${dir}`);
        const want = ordered(dir)
          .filter((r) => r.visible)
          .map((r) => r.id);
        expect(served(pages)).toEqual(want);
        // With limit=1 the ceiling stops inside the hidden NULL run, and the
        // walk resumes from that NULL position.
        if (limit === 1) {
          const bind = { collection: `zvd_${COLLECTION}`, sort: 'rank', desc: dir === 'desc' };
          const inNullRun = pages
            .slice(1, -1)
            .filter((p) => p.records.length === 0)
            .map((p) => openCursor(p.next_cursor!, bind))
            .some((pos) => pos !== null && pos !== 'start' && pos.val === null);
          expect(inNullRun).toBe(true);
        }
      });
    }
  }
});
