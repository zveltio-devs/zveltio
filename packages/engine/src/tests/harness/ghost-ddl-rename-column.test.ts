/**
 * Phase C — GhostDDL.execute RENAME COLUMN on real Postgres (ghost-ddl.ts).
 *
 * RENAME preserves column count so batchCopy INSERT…SELECT * stays valid
 * (DROP COLUMN migrations are not exercised here — fewer ghost columns than
 * the source breaks SELECT * batch copy).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgren_${Date.now()}`;

d('ghost DDL rename column (in-process)', () => {
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
        { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const seed = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'main', subtitle: 'renamed-value' }),
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

  it('GhostDDL.execute renames a column and preserves row data', async () => {
    await GhostDDL.execute(db, tableName, ['RENAME COLUMN subtitle TO tagline']);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name IN ('subtitle', 'tagline')
    `.execute(db);
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toContain('tagline');
    expect(names).not.toContain('subtitle');

    const rows = await sql<{ tagline: string }>`
      SELECT tagline FROM ${sql.id(tableName)}
    `.execute(db);
    expect(rows.rows.some((r) => r.tagline === 'renamed-value')).toBe(true);
  });
});
