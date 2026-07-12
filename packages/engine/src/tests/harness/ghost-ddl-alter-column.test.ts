/**
 * Phase C — GhostDDL.execute ALTER COLUMN on real Postgres (ghost-ddl.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgalt_${Date.now()}`;

d('ghost DDL alter column (in-process)', () => {
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
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const seed = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'alter-me', note: 'original' }),
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

  it('GhostDDL.execute alters a column default without losing rows', async () => {
    await GhostDDL.execute(db, tableName, [`ALTER COLUMN note SET DEFAULT 'ghost-default'`]);

    const rows = await sql<{ note: string | null }>`
      SELECT note FROM ${sql.id(tableName)} WHERE title = 'alter-me'
    `.execute(db);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.rows[0]!.note).toBe('original');
  });
});
