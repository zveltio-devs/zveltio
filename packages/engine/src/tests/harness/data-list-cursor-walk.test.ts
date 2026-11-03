/**
 * A client that pages `GET /api/data/:collection` by `next_cursor` must read
 * every visible row exactly once (handlers/list.ts).
 *
 * Three ways the walk went wrong:
 * - entity access removed a whole page, no cursor came back and the walk
 *   stopped although later pages held visible rows;
 * - a NULL sort value fell out of the keyset `(col, id) > (val, id)`, and the
 *   cursor of a NULL row carried `created_at` in the sort column's place;
 * - the default `created_at` cursor was a millisecond ISO string against a
 *   microsecond column, so the boundary row came back on the next page.
 * Plus the first page (offset) ordered without the `id` tiebreak the keyset
 * uses, so ties across the first boundary were repeated or skipped.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { entityAccessRegistry } from '../../lib/tenancy/entity-access.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hcurw_${Date.now()}`;
const OWNER = 'harness-cursor-walk';

interface Row {
  id: string;
  rank: number | null;
  label: string;
}

d('data list cursor walk reads every visible row once (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const all: Row[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        {
          name: 'rank',
          type: 'integer',
          required: false,
          unique: false,
          indexed: false,
        },
        {
          name: 'label',
          type: 'text',
          required: true,
          unique: false,
          indexed: false,
        },
      ],
    } as never);
    // 12 rows: ranks with ties and NULLs; `hide*` labels are denied below.
    const ranks = [5, null, 1, 3, 3, 3, null, 2, 8, 9, null, 7];
    for (const [i, rank] of ranks.entries()) {
      const label = i >= 2 && i <= 7 ? `hide${i}` : `show${i}`;
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ rank, label }),
      });
      expect(res.status).toBe(201);
      all.push({ ...((await res.json()) as Row), rank, label });
    }
  });

  afterEach(() => entityAccessRegistry.unregisterAll(OWNER));

  afterAll(async () => {
    if (!db) return;
    entityAccessRegistry.unregisterAll(OWNER);
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

  /** Every id a cursor client collects, in order. */
  async function walk(qs: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res = await app.request(
        `/api/data/${COLLECTION}?limit=2${qs}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { headers: { cookie } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        records: Row[];
        next_cursor: string | null;
      };
      seen.push(...body.records.map((r) => r.id));
      cursor = body.next_cursor;
      if (!cursor) return seen;
    }
    throw new Error('cursor walk did not end');
  }

  const ids = (rows: Row[]) => rows.map((r) => r.id);
  // Postgres: ASC puts NULLs last, DESC first; `id` breaks ties both ways.
  const ordered = (dir: 'asc' | 'desc') =>
    [...all].sort((a, b) => {
      const s = dir === 'asc' ? 1 : -1;
      if (a.rank !== b.rank) {
        if (a.rank === null) return s;
        if (b.rank === null) return -s;
        return (a.rank - b.rank) * s;
      }
      return (a.id < b.id ? -1 : 1) * s;
    });

  it('default sort (created_at, microseconds) ascending: no boundary row repeats', async () => {
    // Inserted one by one, so `created_at` order is insertion order.
    expect(await walk('&order=asc')).toEqual(ids(all));
  });

  it('default sort descending: every row once', async () => {
    expect(await walk('')).toEqual(ids(all).reverse());
  });

  it('sort asc on a nullable column with ties: every row once, in order', async () => {
    expect(await walk('&sort=rank&order=asc')).toEqual(ids(ordered('asc')));
  });

  it('sort desc on a nullable column with ties: every row once, in order', async () => {
    expect(await walk('&sort=rank&order=desc')).toEqual(ids(ordered('desc')));
  });

  it('entity access hiding whole pages does not end the walk', async () => {
    entityAccessRegistry.scope(OWNER).register({
      table: `zvd_${COLLECTION}`,
      check: (record, _user, op) =>
        op === 'view' && (record as Row).label.startsWith('hide') ? 'deny' : 'allow',
    });
    const visible = all.filter((r) => !r.label.startsWith('hide'));
    // Insertion order: rows 2..7 are hidden, three whole pages of two.
    const seen = await walk('&order=asc');
    expect(seen).toEqual(ids(visible));
  });

  it('entity access hiding the whole first page does not end the walk', async () => {
    const denied = (r: Row) =>
      r.label.startsWith('hide') || r.label === 'show0' || r.label === 'show1';
    entityAccessRegistry.scope(OWNER).register({
      table: `zvd_${COLLECTION}`,
      check: (record, _user, op) => (op === 'view' && denied(record as Row) ? 'deny' : 'allow'),
    });
    expect(await walk('&order=asc')).toEqual(ids(all.filter((r) => !denied(r))));
  });
});
