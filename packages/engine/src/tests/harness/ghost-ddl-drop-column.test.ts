/**
 * Phase C — GhostDDL.execute DROP COLUMN on real Postgres (ghost-ddl.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgdrop_${Date.now()}`;

d('ghost DDL drop column (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'legacy', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const seed = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'keep-me', legacy: 'remove-me' }),
    });
    expect([200, 201]).toContain(seed.status);
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

  it('GhostDDL.execute drops a column while preserving rows', async () => {
    await GhostDDL.execute(db, tableName, ['DROP COLUMN legacy']);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'legacy'
    `.execute(db);
    expect(cols.rows.length).toBe(0);

    const rows = await sql<{ title: string }>`
      SELECT title FROM ${sql.id(tableName)}
    `.execute(db);
    expect(rows.rows.some((r) => r.title === 'keep-me')).toBe(true);
  });
});
