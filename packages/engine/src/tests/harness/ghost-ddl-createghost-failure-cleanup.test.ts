/**
 * `execute()` used to call `createGhost` OUTSIDE its own cleanup try/catch. A
 * failure inside `createGhost` — the ALTER TABLE step failing after the ghost
 * table was already created, for instance — reached the caller with the ghost
 * table (and, depending where it fails, the changelog table and trigger) left
 * on disk forever: `sweepGhostOrphans` treats any `_zv_ghost_*` table as one
 * another instance might still be copying into, so it never reclaims it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `ghfail_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;

async function exists(db: Database, name: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM pg_tables
    WHERE schemaname = current_schema() AND tablename = ${name}
  `.execute(db);
  return (r.rows[0]?.n ?? 0) > 0;
}

d('GhostDDL.execute — cleanup when createGhost itself fails', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "_zv_ghost_${TABLE}" CASCADE`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS "_zv_changelog_${TABLE}" CASCADE`).execute(db);
    await dropTestCollection(db, COLLECTION);
  });

  it('does not strand the ghost table when the ALTER TABLE step of createGhost fails', async () => {
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);

    // Passes isAllowedGhostDdl (matches the generic type-tail character class)
    // but fails at the database — after createGhost's step 1 has already
    // created the ghost table.
    await expect(
      GhostDDL.execute(db, TABLE, ['ADD COLUMN bad_col notarealtype']),
    ).rejects.toThrow();

    expect(await exists(db, `_zv_ghost_${TABLE}`)).toBe(false);
    expect(await exists(db, `_zv_changelog_${TABLE}`)).toBe(false);
    // The live table is untouched — this was a ghost-side failure only.
    expect(await exists(db, TABLE)).toBe(true);
  });
});
