/**
 * Phase C — POST create with numeric / money field types (ddl-manager column DDL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hnum_${Date.now()}`;

d('collections numeric field matrix (in-process)', () => {
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

  it('POST / provisions smallint, real, decimal, money, and varchar columns', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: COLLECTION,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'qty', type: 'smallint', required: false, unique: false, indexed: false },
          { name: 'ratio', type: 'real', required: false, unique: false, indexed: false },
          { name: 'price', type: 'decimal', required: false, unique: false, indexed: false },
          { name: 'cost', type: 'money', required: false, unique: false, indexed: false },
          { name: 'sku', type: 'varchar', required: false, unique: false, indexed: false },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, COLLECTION)).toBe(true);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${COLLECTION}`}
        AND column_name IN ('qty', 'ratio', 'price', 'cost', 'sku')
    `.execute(db);
    expect(cols.rows.length).toBe(5);
  });
});
