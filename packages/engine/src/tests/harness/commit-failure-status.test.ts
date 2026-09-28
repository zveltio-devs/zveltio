/**
 * A request whose COMMIT fails is answered as a failure, not with the handler's
 * status.
 *
 * The tenant middleware runs the handler inside the request transaction and
 * commits after `next()` returns. By then Hono has finalized the handler's
 * response, so the 500 the middleware RETURNED from its catch was discarded and
 * the client was told 201 Created for a row that does not exist.
 *
 * The rollback is a real one on the real route: a deferred constraint trigger
 * that refuses the row at COMMIT, after the handler has answered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = `cfs_${Date.now()}`;
const COLLECTION = `${STAMP}_c`;
const TABLE = `zvd_${COLLECTION}`;
const FN = `${STAMP}_refuse`;
const PATH = `/api/data/${COLLECTION}`;

d('a failed COMMIT reaches the client', () => {
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
    // Refuses a row titled `refuse` — at COMMIT, not at the INSERT.
    await sql
      .raw(`CREATE FUNCTION "${FN}"() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF NEW.title = 'refuse' THEN RAISE EXCEPTION 'refused at commit'; END IF;
              RETURN NULL;
            END $$`)
      .execute(db);
    await sql
      .raw(`CREATE CONSTRAINT TRIGGER "${STAMP}_t" AFTER INSERT ON "${TABLE}"
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${FN}"()`)
      .execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`).execute(db);
    await sql.raw(`DROP FUNCTION IF EXISTS "${FN}"()`).execute(db);
    await sql`DELETE FROM zvd_collections WHERE name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_request_logs WHERE path = ${PATH}`.execute(db);
  });

  const write = (title: string) =>
    app.request(PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({ title }),
    });

  const logged = async () =>
    (
      await sql<{ status: number }>`
        SELECT status FROM zv_request_logs WHERE path = ${PATH} ORDER BY status`.execute(db)
    ).rows.map((r) => r.status);

  it('a write refused at COMMIT answers 500, and nothing records it as committed', async () => {
    const res = await write('refuse');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { status?: number };
    expect(body.status).toBe(500);
    const kept = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(TABLE)}`.execute(db);
    expect(kept.rows[0]!.n).toBe(0); // the rollback is real

    // The control commits, and its log row proves the logger is live here.
    const ok = await write('kept');
    expect(ok.status).toBe(201);
    for (let i = 0; i < 40 && !(await logged()).includes(201); i++) await Bun.sleep(50);
    // Exactly one 201, and the refused write logged as what the client was told.
    expect((await logged()).filter((s) => s === 201)).toEqual([201]);
    expect(await logged()).toContain(500);
  }, 30_000);
});
