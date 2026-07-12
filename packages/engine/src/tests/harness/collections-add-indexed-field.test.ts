/**
 * Phase C — DDLManager.addField with indexed:true on real Postgres.
 *
 * The HTTP POST /:name/fields route updates metadata + column DDL but does not
 * emit index DDL; addField is the path that runs getIndexDDL + CONCURRENTLY.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hidx_${Date.now()}`;

d('DDLManager add indexed field (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
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

  it('addField creates a btree index when field.indexed is true', async () => {
    await DDLManager.addField(db, COLLECTION, {
      name: 'priority',
      type: 'integer',
      required: false,
      unique: false,
      indexed: true,
    } as never);

    const idx = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = ${`zvd_${COLLECTION}`}
        AND indexdef LIKE ${'%priority%'}
    `.execute(db);
    expect(idx.rows.length).toBeGreaterThanOrEqual(1);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.some((f: { name: string }) => f.name === 'priority')).toBe(true);
  });
});
