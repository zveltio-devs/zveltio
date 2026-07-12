/**
 * Phase C — POST create with diverse field types (ddl-manager createCollection).
 *
 * Exercises email/url/phone/tags/date/datetime/json/slug/integer/boolean
 * columns through the async create-collection route + pg-boss queue.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hmtx_${Date.now()}`;

d('collections field-type matrix (in-process)', () => {
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

  it('POST / provisions many field-type columns on a new collection', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        display_name: 'Matrix Collection',
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
          { name: 'body', type: 'richtext', required: false, unique: false, indexed: false },
          { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
          { name: 'website', type: 'url', required: false, unique: false, indexed: false },
          { name: 'phone', type: 'phone', required: false, unique: false, indexed: false },
          { name: 'labels', type: 'tags', required: false, unique: false, indexed: false },
          { name: 'due', type: 'date', required: false, unique: false, indexed: false },
          { name: 'scheduled', type: 'datetime', required: false, unique: false, indexed: false },
          { name: 'active', type: 'boolean', required: false, unique: false, indexed: false },
          { name: 'qty', type: 'integer', required: false, unique: false, indexed: false },
          { name: 'meta', type: 'json', required: false, unique: false, indexed: false },
          { name: 'slug_field', type: 'slug', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const meta = await DDLManager.getCollection(db, COLLECTION);
    expect(meta?.has_trgm).toBe(true);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`}
        AND column_name IN (
          'contact', 'website', 'phone', 'labels', 'due', 'scheduled',
          'active', 'qty', 'meta', 'slug_field', 'search_vector', 'search_text'
        )
    `.execute(db);
    expect(cols.rows.length).toBeGreaterThanOrEqual(10);
  });
});
