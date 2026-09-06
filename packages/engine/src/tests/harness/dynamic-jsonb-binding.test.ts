/**
 * A `json` field lands in its column as the JSON value it is.
 *
 * `dynamicInsert`/`dynamicUpdate` bound every value with a bare `sql${v}`. The
 * `json` field type's `deserialize` handed them a JSON STRING, and a string
 * parameter is stored as a jsonb string containing JSON text -- so
 * `jsonb_typeof` said `string`, `payload->>'a'` was NULL and `payload ? 'a'`
 * was false. Every jsonb operator, index and filter over a `json` field was
 * inert.
 *
 * Nothing complained because the field type's `serialize` parses the string
 * back on the way out, so the API round-trip looked correct while the column
 * held something no query could reach.
 *
 * The array case is the one a naive repair gets wrong: passing the raw JS value
 * makes the driver render a Postgres array literal. `lib/jsonb.ts` records all
 * four forms measured against this driver.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hjsonb_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('json fields bind as jsonb (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'payload', type: 'json', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  async function write(payload: unknown, method: 'POST' | 'PATCH', id?: string) {
    const url = id ? `/api/data/${COLLECTION}/${id}` : `/api/data/${COLLECTION}`;
    const res = await app.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ payload }),
    });
    expect([200, 201]).toContain(res.status);
    return (await res.json()) as { id: string };
  }

  const shape = (id: string) =>
    sql<{ t: string; a: string | null; has: boolean }>`
      SELECT jsonb_typeof(payload) AS t, payload->>'a' AS a, (payload ? 'a') AS has
        FROM ${sql.table(TABLE)} WHERE id = ${id}::uuid
    `.execute(db);

  it('an object is queryable with jsonb operators', async () => {
    const row = await write({ a: 1, b: 'x' }, 'POST');
    const r = (await shape(row.id)).rows[0]!;
    expect(r.t).toBe('object');
    expect(r.a).toBe('1');
    expect(r.has).toBe(true);
  });

  it('an array is stored as an array, not a Postgres array literal', async () => {
    const row = await write([{ a: 1 }, { a: 2 }], 'POST');
    const r = (
      await sql<{ t: string; n: number }>`
      SELECT jsonb_typeof(payload) AS t, jsonb_array_length(payload) AS n
        FROM ${sql.table(TABLE)} WHERE id = ${row.id}::uuid
    `.execute(db)
    ).rows[0]!;
    expect(r.t).toBe('array');
    expect(Number(r.n)).toBe(2);
  });

  it('an update binds the same way a create does', async () => {
    const row = await write({ a: 1 }, 'POST');
    await write({ a: 9, c: true }, 'PATCH', row.id);
    const r = (await shape(row.id)).rows[0]!;
    expect(r.t).toBe('object');
    expect(r.a).toBe('9');
  });

  it('the API still round-trips the value it was given', async () => {
    const row = await write({ a: 1, nested: { deep: [1, 2] } }, 'POST');
    const res = await app.request(`/api/data/${COLLECTION}/${row.id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const back = (await res.json()) as { payload: { a: number; nested: { deep: number[] } } };
    expect(back.payload).toEqual({ a: 1, nested: { deep: [1, 2] } });
  });
});
