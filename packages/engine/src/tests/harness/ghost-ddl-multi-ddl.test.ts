/**
 * Phase C — GhostDDL.execute with multiple ADD COLUMN statements.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgmulti_${Date.now()}`;

d('ghost DDL multi-statement (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    const seed = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'multi-ddl-row' }),
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

  it('execute applies several ADD COLUMN changes in one migration', async () => {
    await GhostDDL.execute(db, tableName, [
      `ADD COLUMN alpha TEXT NOT NULL DEFAULT 'a'`,
      `ADD COLUMN beta TEXT NOT NULL DEFAULT 'b'`,
    ]);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name IN ('alpha', 'beta')
      ORDER BY column_name
    `.execute(db);
    expect(cols.rows.map((r) => r.column_name)).toEqual(['alpha', 'beta']);

    const rows = await sql<{ title: string; alpha: string; beta: string }>`
      SELECT title, alpha, beta FROM ${sql.id(tableName)}
    `.execute(db);
    expect(rows.rows[0]?.title).toBe('multi-ddl-row');
    expect(rows.rows[0]?.alpha).toBe('a');
    expect(rows.rows[0]?.beta).toBe('b');
  });
});
