/**
 * Phase C — vector field type on pgvector-enabled Postgres (ddl-manager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hvec_${Date.now()}`;

d('collections vector field (in-process)', () => {
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

  it('DDLManager.createCollection provisions a pgvector column', async () => {
    const ext = await sql<{ extname: string }>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `.execute(db);
    if (ext.rows.length === 0) {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db).catch(() => {});
    }

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        {
          name: 'embedding',
          type: 'vector',
          required: false,
          unique: false,
          indexed: false,
          options: { dimensions: 3 },
        },
      ],
    } as never);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const cols = await sql<{ column_name: string; udt_name: string }>`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`} AND column_name = 'embedding'
    `.execute(db);
    expect(cols.rows.length).toBe(1);
    expect(cols.rows[0]!.udt_name).toBe('vector');
  }, 120_000);
});
