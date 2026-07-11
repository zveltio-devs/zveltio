/**
 * Phase C — collection create with FTS/trgm fields (ddl-manager createCollection).
 *
 * POST-creates a collection with text + richtext + email fields so the
 * search_vector / search_text / trgm trigger path in ddl-manager.ts runs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hfts_${Date.now()}`;

d('collections FTS DDL (in-process)', () => {
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

  it('POST / creates a collection with FTS-enabled text fields', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'body', type: 'richtext', required: false, unique: false, indexed: false },
          { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
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
        AND column_name IN ('search_vector', 'search_text')
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('search_vector');
    expect(names).toContain('search_text');
  });
});
