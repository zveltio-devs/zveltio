/**
 * Running one scheduled backup, in the one place that knows how.
 *
 * This body used to live inside `POST /schedules/:id/trigger`, which is why the
 * schedules feature had no scheduler: there was nothing to call. The route now
 * calls this, and so does `scheduleBackups`.
 *
 * The copy that stayed in the route also had its own idea of where the database
 * was — see `resolveDumpTarget` in `routes/backup.ts` for what that cost.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

/** Where dumps land. Same default as the routes, read the same way. */
const BACKUP_DIR = process.env.BACKUP_DIR || '/tmp/zveltio-backups';

export interface DumpTarget {
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
}

export interface ScheduledBackupOutcome {
  backupId: string;
  filename: string;
  status: 'completed' | 'failed';
  error?: string;
}

/**
 * Take a dump for one schedule and record the outcome in both places.
 *
 * `actorId` is the user for a manual trigger and null when the scheduler runs
 * it. `zv_backups.created_by` is `text` and nullable, so an unattended run is
 * recorded as having no actor rather than borrowing one — a backup nobody asked
 * for should not name somebody who did not ask for it.
 *
 * Awaited, unlike the route's old fire-and-forget: the scheduler needs to know
 * whether the run finished before it decides anything about the next one.
 */
export async function runScheduledBackup(
  db: Database,
  opts: {
    scheduleId: string;
    scheduleName: string;
    target: DumpTarget;
    actorId: string | null;
    note?: string;
  },
): Promise<ScheduledBackupOutcome> {
  const { scheduleId, scheduleName, target, actorId } = opts;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-schedule-${scheduleId}-${timestamp}.sql.gz`;
  const filepath = `${BACKUP_DIR}/${filename}`;
  const note = opts.note ?? `Triggered by schedule: ${scheduleName}`;

  const inserted = await sql<{ id: string }>`
    INSERT INTO zv_backups (filename, status, created_by, notes)
    VALUES (${filename}, 'in_progress', ${actorId}, ${note})
    RETURNING id::text
  `.execute(db);
  const backupId = inserted.rows[0]!.id;

  try {
    await Bun.spawn(['mkdir', '-p', BACKUP_DIR]).exited;

    const pgdump = Bun.spawn(
      [
        'pg_dump',
        '-h',
        target.host,
        '-p',
        String(target.port),
        '-U',
        target.user,
        '-d',
        target.name,
      ],
      {
        env: { ...process.env, PGPASSWORD: target.password } as Record<string, string>,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const gzip = Bun.spawn(['gzip', '-c'], { stdin: pgdump.stdout, stdout: Bun.file(filepath) });
    await Promise.all([pgdump.exited, gzip.exited]);

    if (pgdump.exitCode !== 0) {
      const stderr = await new Response(pgdump.stderr).text();
      throw new Error(`pg_dump failed (exit ${pgdump.exitCode}): ${stderr}`);
    }
    if (!(await Bun.file(filepath).exists())) {
      throw new Error('Backup file was not created');
    }

    // 0600: the file holds the whole database, password hashes and customer data
    // included, and the usual umask would leave it world-readable.
    if (process.platform !== 'win32') {
      await Bun.spawn(['chmod', '600', filepath]).exited.catch(() => {});
    }

    const size = Bun.file(filepath).size;

    // The backup's status and the schedule's `last_run_status` are one outcome
    // written twice. Split, they can disagree — the schedule saying `completed`
    // while the backup row says nothing was written, or the reverse — and both
    // readings are worse than an error, because both are believed.
    await db.transaction().execute(async (trx) => {
      await sql`
        UPDATE zv_backups SET status = 'completed', size_bytes = ${size}, completed_at = NOW()
        WHERE id = ${backupId}
      `.execute(trx);
      await sql`
        UPDATE zv_backup_schedules SET last_run_at = NOW(), last_run_status = 'completed'
        WHERE id = ${scheduleId}
      `.execute(trx);
    });

    return { backupId, filename, status: 'completed' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backup] schedule ${scheduleId} failed:`, msg);
    await db
      .transaction()
      .execute(async (trx) => {
        await sql`UPDATE zv_backups SET status = 'failed', error = ${msg} WHERE id = ${backupId}`.execute(
          trx,
        );
        await sql`
          UPDATE zv_backup_schedules SET last_run_at = NOW(), last_run_status = 'failed'
          WHERE id = ${scheduleId}
        `.execute(trx);
      })
      // A failure to RECORD the failure must not replace it: the original
      // message is what an operator needs, and it is already returned below.
      .catch((e) => console.error('[backup] could not record the failure:', e));

    return { backupId, filename, status: 'failed', error: msg };
  }
}
