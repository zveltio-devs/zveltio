/**
 * Phase C — DDLManager.addField with defaultValue (ddl-manager.ts column DDL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdef_${Date.now()}`;

d('collections add field default (in-process)', () => {
  let db: Database;
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await DDLManager.addField(db, COLLECTION, {
      name: 'phase',
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
      defaultValue: 'draft',
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('addField with defaultValue applies a column DEFAULT in Postgres', async () => {
    const def = await sql<{ column_default: string | null }>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'phase'
    `.execute(db);
    expect(def.rows[0]?.column_default).toBeTruthy();
    expect(String(def.rows[0]?.column_default)).toContain('draft');

    await sql`
      INSERT INTO ${sql.id(tableName)} (title) VALUES ('no-status')
    `.execute(db);
    const row = await sql<{ phase: string }>`
      SELECT phase FROM ${sql.id(tableName)} WHERE title = 'no-status'
    `.execute(db);
    expect(row.rows[0]?.phase).toBe('draft');
  });
});
