/**
 * Phase C — collection create with location field (postgis extension + ddl-manager).
 *
 * Uses DDLManager directly — postgis extension install can exceed the default
 * 5s harness timeout when routed through the async DDL queue.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hloc_${Date.now()}`;

d('collections location / postgis (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
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

  it('createCollection provisions a geometry column and enables postgis', async () => {
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'coords', type: 'location', required: false, unique: false, indexed: false },
      ],
    } as never);

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
  }, 120_000);
});
