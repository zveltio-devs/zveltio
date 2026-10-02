/**
 * Writes that run WHILE GhostDDL.execute runs are all in the table after it.
 *
 * ghost-ddl-changelog-live interleaves its inserts between the steps by hand,
 * so it never lands a write inside the swap: the LOCK, the last changelog
 * replay and the rename. Here a writer inserts on the pool for the whole
 * migration. A write blocked by the LOCK resumes after the rename and must
 * reach the new table, not `_zv_old_<table>`, which is dropped later.
 *
 * Ported from the deleted src/tests/stress/ghost-ddl.stress.test.ts, the one
 * case the harness ghost-ddl-* files did not cover.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL, sweepGhostOrphans } from '../../lib/data/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hghostcc_${Date.now()}`;
const SEEDED = 5000;

d('ghost DDL with concurrent writes', () => {
  let db: Database;
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await sql`
      INSERT INTO ${sql.id(tableName)} (title)
      SELECT 'seed-' || g FROM generate_series(1, ${SEEDED}) g
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of [`_zv_old_${tableName}`, `_zv_changelog_${tableName}`, tableName]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "${t}" CASCADE`)
        .execute(db)
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sweepGhostOrphans(db);
  });

  it('keeps every row written during the migration', async () => {
    let done = false;
    const written: string[] = [];
    const writer = (async () => {
      for (let i = 0; !done; i++) {
        const title = `live-${i}`;
        await sql`INSERT INTO ${sql.id(tableName)} (title) VALUES (${title})`.execute(db);
        written.push(title);
      }
    })();

    await GhostDDL.execute(db, tableName, [
      {
        kind: 'add_column',
        field: { name: 'tag', type: 'text', required: true, defaultValue: 'migrated' },
      },
    ]);
    done = true;
    await writer;

    // The writer has to have overlapped the migration, or this proves nothing.
    expect(written.length).toBeGreaterThan(0);
    const rows = await sql<{ title: string }>`
      SELECT title FROM ${sql.id(tableName)} WHERE title LIKE 'live-%'
    `.execute(db);
    const kept = new Set(rows.rows.map((r) => r.title));
    expect(written.filter((t) => !kept.has(t))).toEqual([]);
    const total = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(tableName)}
    `.execute(db);
    expect(total.rows[0]!.n).toBe(SEEDED + written.length);
  }, 60_000);
});
