/**
 * Phase C — collection create with time / interval field types (ddl-manager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `htime_${Date.now()}`;

d('collections time field types (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
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

  it('POST / provisions time, timetz, and interval columns', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'starts', type: 'time', required: false, unique: false, indexed: false },
          { name: 'starts_tz', type: 'timetz', required: false, unique: false, indexed: false },
          { name: 'duration', type: 'interval', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`}
        AND column_name IN ('starts', 'starts_tz', 'duration')
    `.execute(db);
    expect(cols.rows.length).toBe(3);
  });
});
