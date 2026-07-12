/**
 * Phase C — POST create with reference FK field (ddl-manager reference type).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PUBLISHERS = `hrefpub_${Date.now()}`;
const BOOKS = `hrefbook_${Date.now()}`;

d('collections reference create route (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: PUBLISHERS,
      fields: [{ name: 'name', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [BOOKS, PUBLISHERS]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_relations')
      .where('source_collection', '=', BOOKS)
      .execute()
      .catch(() => {});
  });

  it('POST / creates a child with a reference FK to the publisher table', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: BOOKS,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          {
            name: 'publisher',
            type: 'reference',
            required: false,
            unique: false,
            indexed: true,
            options: { related_collection: PUBLISHERS, on_delete: 'SET NULL' },
          },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, BOOKS)).toBe(true);

    const rel = await db
      .selectFrom('zvd_relations')
      .selectAll()
      .where('source_collection', '=', BOOKS)
      .where('source_field', '=', 'publisher')
      .executeTakeFirst();
    expect(rel?.target_collection).toBe(PUBLISHERS);
    expect(rel?.type).toBe('m2o');

    const fk = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${BOOKS}`} AND column_name = 'publisher'
    `.execute(db);
    expect(fk.rows.length).toBe(1);
  });
});
