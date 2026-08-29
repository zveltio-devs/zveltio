/**
 * `?count=none` — the page without the `count(*)` nobody asked for.
 *
 * Every offset-paginated list ran a `count(*)` over the caller's whole tenant to
 * fill `pagination.total`. Measured on a 300 000-row collection with 100 000 rows
 * in the tenant: the count took **10,06 ms** beside a **1,63 ms** page. Six
 * sevenths of the request, and it scales with the tenant rather than the page.
 *
 * The cursor path already avoided it by fetching one row past the limit; this
 * gives the offset path the same option. The default is unchanged, so nothing
 * that renders "page 3 of 40" moves.
 *
 * What these tests actually guard is not the speed — it is that "is there more"
 * stays right without a total to compare against. A `next_cursor` on the last
 * page is a client that loops forever.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `cntmode_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;
const ROWS = 7;

type ListBody = {
  records: { id: string }[];
  pagination: { total?: number; pages?: number; page: number; limit: number };
  next_cursor: string | null;
};

d('data list count mode (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < ROWS; i++) {
      await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('row ${i}')`).execute(db);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, COLLECTION);
  });

  const list = async (qs: string): Promise<ListBody> => {
    const res = await app.request(`/api/data/${COLLECTION}?${qs}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  };

  it('still returns a total by default — no existing caller moves', async () => {
    const body = await list('limit=3');
    expect(body.pagination.total).toBe(ROWS);
    expect(body.pagination.pages).toBe(Math.ceil(ROWS / 3));
    expect(body.records.length).toBe(3);
  });

  it('count=none drops the total but returns the same page', async () => {
    const withCount = await list('limit=3');
    const without = await list('limit=3&count=none');

    expect(without.pagination.total).toBeUndefined();
    expect(without.pagination.pages).toBeUndefined();
    expect(without.records.map((r) => r.id)).toEqual(withCount.records.map((r) => r.id));
  });

  it('returns exactly the page size, not the probe row', async () => {
    // The extra row is how "has more" is answered; handing it to the caller
    // would make every page one longer than it asked for.
    const body = await list('limit=3&count=none');
    expect(body.records.length).toBe(3);
  });

  it('offers a cursor while there is more, and stops on the last page', async () => {
    const first = await list('limit=3&count=none');
    expect(first.next_cursor).not.toBeNull();

    // 7 rows, 3 per page: page 3 holds one row and is the end of the set.
    const last = await list('limit=3&count=none&page=3');
    expect(last.records.length).toBe(1);
    expect(last.next_cursor).toBeNull();
  });

  it('a page that lands exactly on the end offers no cursor', async () => {
    // The off-by-one that a `limit + 1` probe exists to get right: asking for
    // all 7 with a limit of 7 must not claim an eighth.
    const body = await list(`limit=${ROWS}&count=none`);
    expect(body.records.length).toBe(ROWS);
    expect(body.next_cursor).toBeNull();
  });

  it('rejects a count mode nobody defined', async () => {
    const res = await app.request(`/api/data/${COLLECTION}?count=approximately`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });
});
