/**
 * Phase C — GhostDDL.execute on real Postgres (lib/data/ghost-ddl.ts).
 *
 * Provisions a managed collection, seeds a row, then runs the full
 * createGhost → batchCopy → applyChangelog → atomicSwap pipeline to add a
 * column without dropping the table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hghost_${Date.now()}`;

d('ghost DDL execute (in-process)', () => {
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
      body: JSON.stringify({ title: 'before-migration' }),
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

  it('GhostDDL.execute adds a column and preserves existing rows', async () => {
    const phases: string[] = [];
    await GhostDDL.execute(
      db,
      tableName,
      [`ADD COLUMN tag TEXT NOT NULL DEFAULT 'migrated'`],
      (phase) => phases.push(phase),
    );

    expect(phases[0]).toBe('creating');
    expect(phases).toContain('copying');
    expect(phases).toContain('changelog');
    expect(phases).toContain('swapping');
    expect(phases[phases.length - 1]).toBe('done');

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'tag'
    `.execute(db);
    expect(cols.rows.length).toBe(1);

    const rows = await sql<{ title: string; tag: string }>`
      SELECT title, tag FROM ${sql.id(tableName)}
    `.execute(db);
    expect(rows.rows.some((r) => r.title === 'before-migration' && r.tag === 'migrated')).toBe(
      true,
    );
  });
});
