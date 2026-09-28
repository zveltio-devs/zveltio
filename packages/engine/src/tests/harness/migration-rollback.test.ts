/**
 * `zveltio rollback` then the next start re-applies what was rolled back.
 *
 * It did not: the rollback kept the `zv_schema_versions` row (marked
 * `rolled_back_at`), `applyMigration` found the row and returned "already
 * applied", and the rolled-back schema never came back — nor could it, since
 * `version` is UNIQUE and the insert that would have re-recorded it failed into
 * a warning.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import {
  assertChainCompatible,
  getAppliedMigrations,
  getLastAppliedMigration,
  rollbackMigration,
  runPending,
} from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('migration rollback', () => {
  it('rolls the latest migration back once, and the next run re-applies it', async () => {
    const { db } = await getTestApp();
    const latest = await getLastAppliedMigration(db);
    expect(latest).toBeGreaterThan(1);

    expect(await rollbackMigration(db, latest - 1)).toEqual({ success: true });
    expect((await getAppliedMigrations(db)).map((m) => m.version)).not.toContain(latest);
    // Already rolled back: nothing left above the target to undo.
    expect((await rollbackMigration(db, latest - 1)).success).toBe(false);

    // Editing a rolled-back migration is the point of rolling back: the boot
    // guard must not read the stale row's checksum as a divergence.
    await sql`UPDATE zv_schema_versions SET checksum = 'edited-since'
               WHERE version = ${latest}`.execute(db);
    await assertChainCompatible(db);

    await runPending(db);
    await assertChainCompatible(db);
    expect(await getLastAppliedMigration(db)).toBe(latest);
    const row = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_schema_versions
       WHERE version = ${latest} AND rolled_back_at IS NULL`.execute(db);
    expect(row.rows[0]?.n).toBe(1);
  }, 60_000);
});
