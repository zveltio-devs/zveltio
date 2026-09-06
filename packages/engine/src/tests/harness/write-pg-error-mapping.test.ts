/**
 * A constraint the database refuses is a 4xx on every write route, not only on
 * three of them.
 *
 * `handlePgErrors` translates SQLSTATEs into structured 4xx bodies. It wraps
 * create, replace and patch in `handlers/single.ts` -- and nothing else. Single
 * DELETE and all three bulk handlers run bare, so a foreign key that refuses a
 * delete, or a duplicate inside a batch, escapes to Hono's default handler as
 * 500 "Internal Server Error" with no field, no code and nothing for the caller
 * to act on. The same violation through `POST /:collection` answers 409 and
 * names the column.
 *
 * On the bulk path it costs more than a status: the throw leaves `runAtomic`,
 * so the whole batch rolls back on one bad row -- the per-row `errors` array
 * the endpoint is built around never gets the chance to report it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hpgerr_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const CHILD = `${TABLE}_child`;

d('write paths map Postgres errors (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'code', type: 'text', required: true, unique: true, indexed: false }],
    } as never);

    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    const made = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ code: 'first' }),
    });
    expect(made.status).toBe(201);
    parentId = ((await made.json()) as { id: string }).id;

    // A child that refuses to let its parent go, which is what an ordinary
    // relation between two collections is.
    await sql
      .raw(
        `CREATE TABLE "${CHILD}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ` +
          `parent_id UUID REFERENCES "${TABLE}"(id) ON DELETE RESTRICT)`,
      )
      .execute(db);
    await sql.raw(`INSERT INTO "${CHILD}" (parent_id) VALUES ('${parentId}')`).execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${CHILD}" CASCADE`)
      .execute(db)
      .catch(() => {});
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

  it('the single create path already answers 409 and names the field', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ code: 'first' }),
    });
    expect(res.status).toBe(409);
    // `23505`, not `ERR_POSTGRES_SERVER_ERROR`: the SQLSTATE lives in `errno` on
    // this driver, and reading `code` first published the driver's marker.
    expect((await res.json()) as { detail: string; code: string }).toMatchObject({
      detail: 'unique_violation',
      code: '23505',
    });
  });

  it('a delete a foreign key refuses is 422, not 500', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${parentId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as { detail: string }).toMatchObject({
      detail: 'foreign_key_violation',
    });
  });

  it('a duplicate inside a batch is 409, not 500', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ records: [{ code: 'first' }] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { detail: string }).toMatchObject({ detail: 'unique_violation' });
  });
});
