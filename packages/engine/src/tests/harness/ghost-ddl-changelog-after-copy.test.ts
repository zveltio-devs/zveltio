/**
 * GhostDDL changelog replay on real Postgres, for writes that land AFTER the
 * copy (lib/data/ghost-ddl.ts).
 *
 * The sibling changelog-* files write before `batchCopy`, so the copy already
 * carries the change and the replay has nothing to do: every harness test passed
 * with `applyChangelog` replaced by a no-op. Here the writes follow the copy,
 * so only the replay can bring them across — and it has to do so through the
 * `to_jsonb(NEW)` snapshot, which turns numeric, boolean, timestamptz, jsonb and
 * text[] values into JSON before they are bound back into typed columns.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgac_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('ghost DDL changelog replay after the copy (in-process)', () => {
  let db: Database;

  /** Every row as JSON, keyed by id, with the renamed column under its old name. */
  const snapshot = async (renamed: boolean) => {
    const r = renamed
      ? await sql<{ id: string; j: Record<string, unknown> }>`
          SELECT id::text AS id,
                 (to_jsonb(t) - 'extra' - 'memo') || jsonb_build_object('note', t.memo) AS j
          FROM ${sql.id(TABLE)} t`.execute(db)
      : await sql<{ id: string; j: Record<string, unknown> }>`
          SELECT id::text AS id, to_jsonb(t) AS j FROM ${sql.id(TABLE)} t`.execute(db);
    return Object.fromEntries(r.rows.map((x) => [x.id, x.j]));
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
        { name: 'qty', type: 'integer', required: false, unique: false, indexed: false },
        { name: 'price', type: 'decimal', required: false, unique: false, indexed: false },
        { name: 'flag', type: 'boolean', required: false, unique: false, indexed: false },
        { name: 'at', type: 'datetime', required: false, unique: false, indexed: false },
        { name: 'meta', type: 'json', required: false, unique: false, indexed: false },
        { name: 'labels', type: 'tags', required: false, unique: false, indexed: false },
      ],
    } as never);
    await sql`
      INSERT INTO ${sql.id(TABLE)} (title, note, qty, tenant_id)
      SELECT 'r' || g, 'n' || g, g, ${DEFAULT_TENANT_ID}::uuid FROM generate_series(1, 3) g
    `.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    for (const t of [`_zv_ghost_${TABLE}`, `_zv_changelog_${TABLE}`, TABLE]) {
      await sql`DROP TABLE IF EXISTS ${sql.id(t)} CASCADE`.execute(db).catch(() => {});
    }
    await sweepGhostOrphans(db);
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('carries inserts, updates and deletes made after batchCopy, typed values intact', async () => {
    const migration = await GhostDDL.createGhost(db, TABLE, [
      { kind: 'rename_column', from: 'note', to: 'memo' },
      { kind: 'add_column', field: { name: 'extra', type: 'text' } },
    ]);
    expect(await GhostDDL.batchCopy(db, migration)).toBe(3);

    await sql`
      INSERT INTO ${sql.id(TABLE)} (title, note, qty, price, flag, at, meta, labels, tenant_id)
      VALUES ('late', 'late-note', 7, 12.50, true, '2026-09-30T10:11:12.345Z',
              '{"a":[1,{"b":"c"}],"n":null}'::jsonb, ARRAY['x','y z'], ${DEFAULT_TENANT_ID}::uuid)
    `.execute(db);
    await sql`
      UPDATE ${sql.id(TABLE)}
      SET note = 'changed', price = 0.10, flag = false, meta = '[1,2]'::jsonb, labels = ARRAY['q']
      WHERE title = 'r1'
    `.execute(db);
    await sql`DELETE FROM ${sql.id(TABLE)} WHERE title = 'r2'`.execute(db);

    // A replay takes what it applied out of the changelog, so the one under the
    // swap's lock only reads what landed since.
    expect(await GhostDDL.applyChangelog(db, migration)).toBe(3);
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.id(migration.changelogTable)}`.execute(db);
    expect(left.rows[0]?.n).toBe(0);
    await sql`UPDATE ${sql.id(TABLE)} SET qty = 99 WHERE title = 'late'`.execute(db);

    const expected = await snapshot(false);
    expect(Object.keys(expected)).toHaveLength(3);

    await GhostDDL.atomicSwap(db, migration);

    expect(await snapshot(true)).toEqual(expected);
  });

  it('carries a write that lands between the last unlocked replay and the swap lock', async () => {
    const migration = await GhostDDL.createGhost(db, TABLE, [
      { kind: 'add_column', field: { name: 'extra2', type: 'text' } },
    ]);
    await GhostDDL.batchCopy(db, migration);

    // The swap replays once on the pool, then again under its lock. A write in
    // between reaches only the second.
    const unlocked = GhostDDL.applyChangelog.bind(GhostDDL);
    let calls = 0;
    const spy = spyOn(GhostDDL, 'applyChangelog').mockImplementation(async (on, m) => {
      const n = await unlocked(on, m);
      if (++calls === 1) {
        await sql`UPDATE ${sql.id(TABLE)} SET qty = 123 WHERE title = 'late'`.execute(db);
      }
      return n;
    });
    try {
      await GhostDDL.atomicSwap(db, migration);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    const late = await sql<{ qty: number }>`
      SELECT qty FROM ${sql.id(TABLE)} WHERE title = 'late'`.execute(db);
    expect(Number(late.rows[0]?.qty)).toBe(123);
  });
});
