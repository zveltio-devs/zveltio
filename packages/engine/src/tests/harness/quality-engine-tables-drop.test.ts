/**
 * Migration 109 drops the engine's `zv_quality_scans` / `zv_quality_issues`.
 *
 * On a database that ran `analytics/quality` 1.x, `zvd_quality_remediations`
 * (and `zvd_quality_scores`, when its 004 has not run) holds a foreign key into
 * them, and a plain DROP refuses: the engine would not boot. The 1.x shape is
 * rebuilt here inside a transaction that is rolled back, so the shared harness
 * database keeps what the migration chain left it.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLLBACK = new Error('rollback');

d('109 drops the engine quality tables on a 1.x install', () => {
  it('drops both past the 1.x foreign keys and keeps the 1.x tables', async () => {
    const { db } = await getTestApp();
    const { up } = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/109_drop_quality_engine_tables.sql', import.meta.url),
      ).text(),
    );
    let tables: string[] = [];
    const run = db.transaction().execute(async (trx) => {
      // A database that once ran 1.x still has its tables: start from none.
      await sql`DROP TABLE IF EXISTS zvd_quality_remediations, zvd_quality_scores`.execute(trx);
      await sql`CREATE TABLE zv_quality_scans (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`.execute(
        trx,
      );
      await sql`CREATE TABLE zv_quality_issues (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scan_id UUID NOT NULL REFERENCES zv_quality_scans(id) ON DELETE CASCADE)`.execute(trx);
      await sql`CREATE TABLE zvd_quality_remediations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        issue_id UUID NOT NULL REFERENCES zv_quality_issues(id) ON DELETE CASCADE)`.execute(trx);
      await sql`CREATE TABLE zvd_quality_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        scan_id UUID NOT NULL REFERENCES zv_quality_scans(id) ON DELETE CASCADE)`.execute(trx);
      await sql`WITH s AS (INSERT INTO zv_quality_scans DEFAULT VALUES RETURNING id),
                     i AS (INSERT INTO zv_quality_issues (scan_id) SELECT id FROM s RETURNING id)
                INSERT INTO zvd_quality_remediations (issue_id) SELECT id FROM i`.execute(trx);

      await sql.raw(up).execute(trx);

      tables = (
        await sql<{ t: string }>`
          SELECT tablename AS t FROM pg_tables
           WHERE schemaname = current_schema()
             AND tablename IN ('zv_quality_scans', 'zv_quality_issues',
                               'zvd_quality_remediations', 'zvd_quality_scores')
           ORDER BY 1`.execute(trx)
      ).rows.map((r) => r.t);
      throw ROLLBACK;
    });
    await expect(run).rejects.toBe(ROLLBACK);
    expect(tables).toEqual(['zvd_quality_remediations', 'zvd_quality_scores']);
  });
});
