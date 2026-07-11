/**
 * Phase C — create collection with diverse field types (ddl-manager + field-type-registry).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrich_${Date.now()}`;

d('collections rich field types (in-process)', () => {
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

  it('POST / provisions integer, boolean, json, and datetime columns', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'qty', type: 'integer', required: false, unique: false, indexed: true },
          { name: 'active', type: 'boolean', required: false, unique: false, indexed: false },
          { name: 'meta', type: 'json', required: false, unique: false, indexed: false },
          { name: 'due_at', type: 'datetime', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`}
        AND column_name IN ('qty', 'active', 'meta', 'due_at')
    `.execute(db);
    expect(cols.rows.length).toBe(4);
  });
});
