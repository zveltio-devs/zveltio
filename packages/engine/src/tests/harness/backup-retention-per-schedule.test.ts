/**
 * Each backup schedule keeps its own `retention_count` newest dumps.
 *
 * The count was accepted, editable and returned by the schedules API and read
 * by nothing: pruning kept the newest 20 backups overall, because `zv_backups`
 * could not say which schedule wrote a row. Migration 037 records it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { cleanupOldBackups } from '../../lib/backup/run-scheduled-backup.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAG = `ret-${Date.now()}`;

d('backup retention per schedule', () => {
  let db: Database;
  let scheduleId = '';

  const rows = async () =>
    (
      await sql<{ filename: string }>`
        SELECT filename FROM zv_backups WHERE notes = ${TAG}
      `.execute(db)
    ).rows
      .map((r) => r.filename)
      .sort();

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const s = await sql<{ id: string }>`
      INSERT INTO zv_backup_schedules (name, cron_expression, retention_count, created_by)
      VALUES (${TAG}, '0 3 * * *', 2, 'harness') RETURNING id::text
    `.execute(db);
    scheduleId = s.rows[0]!.id;
    // Four dumps by the schedule, oldest first; files that do not exist on disk
    // are fine — pruning removes the row either way.
    for (let i = 0; i < 4; i++) await backup(`s${i}`, 'completed', scheduleId, -10 + i);
    // Must not count toward the schedule's two, nor be pruned: a failed run.
    await backup('s-failed', 'failed', scheduleId, -1);
    // Newer and unscheduled: ranked together with the schedule's rows, they
    // would push all four out; under the 20 kept for unscheduled, they stay.
    // In the future so they are the newest unscheduled rows the database has.
    for (let i = 0; i < 2; i++) await backup(`u${i}`, 'completed', null, 60 + i);
  });

  const backup = (name: string, status: string, schedule: string | null, mins: number) =>
    sql`
      INSERT INTO zv_backups (filename, status, notes, schedule_id, created_at)
      VALUES (${`${TAG}-${name}.sql.gz`}, ${status}, ${TAG}, ${schedule}::uuid,
              NOW() + make_interval(mins => ${mins}))
    `.execute(db);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_backups WHERE notes = ${TAG}`.execute(db);
    await sql`DELETE FROM zv_backup_schedules WHERE id = ${scheduleId}::uuid`.execute(db);
  });

  it("keeps the schedule's retention_count newest, not the global 20", async () => {
    await cleanupOldBackups(db);
    expect(await rows()).toEqual(
      ['s-failed', 's2', 's3', 'u0', 'u1'].map((n) => `${TAG}-${n}.sql.gz`),
    );
  });
});
