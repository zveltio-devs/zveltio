/**
 * A slow request is recorded with the status the client was told.
 *
 * The slow-query middleware sits inside the request transaction. It used to
 * read `c.res.status` right after `next()` — before the COMMIT — and write that
 * number once the request settled. A request whose COMMIT then failed answered
 * 500 and was recorded as 201: the slow requests that went on to fail, which
 * the log exists for, looked like successes.
 *
 * Real route, real rollback: a BEFORE trigger makes the insert slow, and a
 * deferred constraint trigger refuses the row at COMMIT.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `sqs_${Date.now()}`;
const COLLECTION = `${STAMP}_c`;
const TABLE = `zvd_${COLLECTION}`;
const PATH = `/api/data/${COLLECTION}`;
// Above the middleware's 200 ms default threshold.
const SLOW_S = Number(process.env.SLOW_QUERY_THRESHOLD_MS ?? '200') / 1000 + 0.1;

d('a slow request whose COMMIT fails is recorded as the failure it was', () => {
  let app: Hono;
  let db: Database;
  let god = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await sql
      .raw(`CREATE FUNCTION "${STAMP}_slow"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(${SLOW_S}); RETURN NEW; END $$`)
      .execute(db);
    await sql
      .raw(`CREATE TRIGGER "${STAMP}_s" BEFORE INSERT ON "${TABLE}"
            FOR EACH ROW EXECUTE FUNCTION "${STAMP}_slow"()`)
      .execute(db);
    await sql
      .raw(`CREATE FUNCTION "${STAMP}_refuse"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'refused at commit'; END $$`)
      .execute(db);
    await sql
      .raw(`CREATE CONSTRAINT TRIGGER "${STAMP}_t" AFTER INSERT ON "${TABLE}"
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${STAMP}_refuse"()`)
      .execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${STAMP}_slow"()`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${STAMP}_refuse"()`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_slow_queries WHERE path = ${PATH}`.execute(db);
    await sql`DELETE FROM zv_request_logs WHERE path = ${PATH}`.execute(db);
  });

  it('records 500, not the 201 the handler rendered before the COMMIT', async () => {
    const res = await app.request(PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title: 'x' }),
    });
    expect(res.status).toBe(500);

    const recorded = async () =>
      (
        await sql<{ s: number }>`
          SELECT status_code AS s FROM zv_slow_queries WHERE path = ${PATH}`.execute(db)
      ).rows.map((r) => r.s);
    for (let i = 0; i < 40 && (await recorded()).length === 0; i++) await Bun.sleep(50);
    expect(await recorded()).toEqual([500]);
  }, 30_000);
});
