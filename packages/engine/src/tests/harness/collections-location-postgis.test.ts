/**
 * Phase C — collection create with location field (postgis extension + ddl-manager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hloc_${Date.now()}`;

d('collections location / postgis (in-process)', () => {
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

  it('POST / provisions a geometry column and enables postgis', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'coords', type: 'location', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const ext = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'postgis'
    `.execute(db);
    expect(ext.rows.some((r) => r.extname === 'postgis')).toBe(true);

    const cols = await sql<{ column_name: string; udt_name: string }>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`} AND column_name = 'coords'
    `.execute(db);
    expect(cols.rows.length).toBe(1);
    expect(cols.rows[0]!.udt_name).toBe('geometry');
  });
});
