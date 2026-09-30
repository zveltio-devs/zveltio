/**
 * GhostDDL keeps the table's index and constraint names through the swap
 * (lib/data/ghost-ddl.ts).
 *
 * `LIKE … INCLUDING ALL` names the ghost's indexes after the ghost table, and
 * the rename that makes the ghost the original does not rename them. The table
 * came out of a migration with its primary key called `_zv_ghost_<table>_pkey`,
 * every later statement naming an index by its usual name missed it, and a
 * second migration stacked another prefix on top.
 *
 * Also two migrations back to back, as a schema-branch merge touching two
 * fields of one large table runs them: the second used to fail on the first's
 * changelog, still waiting for its sixty-second cleanup.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
const COLLECTION = `hgix_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('ghost DDL index names and back-to-back runs (in-process)', () => {
  let db: Database;

  /** Index name → the constraint it backs (if any), plus the index definition's shape. */
  const names = async () => {
    const r = await sql<{ idx: string; con: string | null }>`
      SELECT i.indexrelid::regclass::text AS idx, c.conname::text AS con
      FROM pg_index i LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid
      WHERE i.indrelid = to_regclass(${TABLE})
      ORDER BY 1
    `.execute(db);
    return r.rows;
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'code', type: 'text', required: false, unique: true, indexed: false },
        { name: 'title', type: 'text', required: false, unique: false, indexed: true },
        { name: 'note', type: 'text', required: false, unique: false, indexed: true },
      ],
    } as never);
    await sql`
      INSERT INTO ${sql.id(TABLE)} (code, title, note, tenant_id)
      SELECT 'c' || g, 't' || g, 'n' || g, ${DEFAULT_TENANT_ID}::uuid FROM generate_series(1, 5) g
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

  it('keeps every index and constraint name across two migrations', async () => {
    const before = await names();
    expect(before.length).toBeGreaterThanOrEqual(3);

    await GhostDDL.execute(db, TABLE, ['ADD COLUMN extra TEXT']);
    expect(await names()).toEqual(before);

    // Straight after, as a schema-branch merge with two fields does: the first
    // swap's old copy and changelog are still waiting for their cleanup.
    await GhostDDL.execute(db, TABLE, ['ADD COLUMN more TEXT']);
    expect(await names()).toEqual(before);
  });

  it("a finished run's deferred cleanup leaves the next run's changelog alone", async () => {
    cancelPendingCleanups();
    await sweepGhostOrphans(db);
    let cleanup: (() => Promise<void>) | null = null;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => Promise<void>) => {
      cleanup = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      await GhostDDL.execute(db, TABLE, ['ADD COLUMN third TEXT']);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(cleanup).not.toBeNull();

    const next = await GhostDDL.createGhost(db, TABLE, ['ADD COLUMN fourth TEXT']);
    await cleanup!();
    const left = await sql<{ log: string | null; old: string | null }>`
      SELECT to_regclass(${next.changelogTable})::text AS log,
             to_regclass(${`_zv_old_${TABLE}`})::text AS old
    `.execute(db);
    expect(left.rows[0]).toEqual({ log: next.changelogTable, old: null });

    await GhostDDL.batchCopy(db, next);
    await GhostDDL.atomicSwap(db, next);
  });

  it('keeps the names of the indexes a DROP COLUMN leaves standing', async () => {
    cancelPendingCleanups();
    await sweepGhostOrphans(db);
    const before = await names();
    await GhostDDL.execute(db, TABLE, ['DROP COLUMN note']);
    // Both indexes on `note` — its own and the tenant composite — go with it.
    expect(await names()).toEqual(before.filter((n) => !n.idx.endsWith('_note')));
  });
});
