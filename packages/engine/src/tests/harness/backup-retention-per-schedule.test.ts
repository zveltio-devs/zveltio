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

  const rows = async (scheduleOnly: boolean) =>
    (
      await sql<{ filename: string }>`
        SELECT filename FROM zv_backups
         WHERE notes = ${TAG} AND (${scheduleOnly}::boolean = false OR schedule_id = ${scheduleId}::uuid)
         ORDER BY created_at DESC
      `.execute(db)
    ).rows.map((r) => r.filename);

  beforeAll(async () => {
    ({ db } = await getTestApp());
    const s = await sql<{ id: string }>`
      INSERT INTO zv_backup_schedules (name, cron_expression, retention_count, created_by)
      VALUES (${TAG}, '0 3 * * *', 2, 'harness') RETURNING id::text
    `.execute(db);
    scheduleId = s.rows[0]!.id;
    // Four dumps by the schedule, oldest first; files that do not exist on disk
    // are fine — pruning removes the row either way.
    for (let i = 0; i < 4; i++) {
      await sql`
        INSERT INTO zv_backups (filename, status, notes, schedule_id, created_at)
        VALUES (${`${TAG}-s${i}.sql.gz`}, 'completed', ${TAG}, ${scheduleId}::uuid,
                NOW() - make_interval(mins => ${10 - i}))
      `.execute(db);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_backups WHERE notes = ${TAG}`.execute(db);
    await sql`DELETE FROM zv_backup_schedules WHERE id = ${scheduleId}::uuid`.execute(db);
  });

  it("keeps the schedule's retention_count newest, not the global 20", async () => {
    await cleanupOldBackups(db);
    expect(await rows(true)).toEqual([`${TAG}-s3.sql.gz`, `${TAG}-s2.sql.gz`]);
  });
});
