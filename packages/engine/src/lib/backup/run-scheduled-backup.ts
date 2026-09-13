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

import { chmod } from 'node:fs/promises';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { uploadBackup } from './upload.js';
import { verifyArchive } from './verify-archive.js';

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
 * Delete every completed backup past the newest 20, row and file both.
 *
 * The only caller of this used to be `POST /api/backup` — the one-off "back up
 * now" button. `runScheduledBackup`, which both the cron scheduler and
 * `POST /schedules/:id/trigger` call, never pruned anything: measured live,
 * five scheduled runs against a real database left five rows in `zv_backups`
 * and five files on disk, with nothing capping either. The very feature this
 * file exists to make real — a schedule that actually fires unattended — is
 * the path that most needs a bound on what it leaves behind, since nobody is
 * there afterwards to notice or delete an old dump by hand.
 *
 * This is a global cap, not the per-schedule `retention_count` a schedule
 * stores: `zv_backups` carries no `schedule_id` to group by, so honouring a
 * schedule's own count needs a schema change wider than this file — logged
 * rather than built here.
 */
export async function cleanupOldBackups(db: Database): Promise<void> {
  try {
    const oldBackups = await sql<{ id: string; filename: string }>`
      SELECT id::text, filename FROM zv_backups
      WHERE status = 'completed'
      ORDER BY created_at DESC
      OFFSET 20
    `.execute(db);

    for (const backup of oldBackups.rows) {
      if (!backup.filename.includes('..') && !backup.filename.includes('/')) {
        const filepath = `${BACKUP_DIR}/${backup.filename}`;
        if (await Bun.file(filepath).exists()) {
          const rmProc = Bun.spawn(['rm', '-f', filepath]);
          await rmProc.exited;
        }
      }
      await sql`DELETE FROM zv_backups WHERE id = ${backup.id}`.execute(db);
    }
  } catch (err) {
    console.error('Failed to cleanup old backups:', err);
  }
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
    /** `local` keeps the dump here; `s3`/`both` also copy it off. */
    destination?: 'local' | 's3' | 'both';
    s3Prefix?: string | null;
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
    const gzip = Bun.spawn(['gzip', '-c'], {
      stdin: pgdump.stdout,
      stdout: Bun.file(filepath),
      // Piped so a failure here can say why. Without it the only evidence that
      // the second half of the pipeline died is its exit code.
      stderr: 'pipe',
    });
    await Promise.all([pgdump.exited, gzip.exited]);

    // Both halves, then the archive itself. `pg_dump` first: a dump that failed
    // outright has a better error than anything the archive check can produce.
    if (pgdump.exitCode !== 0) {
      const stderr = await new Response(pgdump.stderr).text();
      throw new Error(`pg_dump failed (exit ${pgdump.exitCode}): ${stderr}`);
    }

    // gzip's exit code, the file, and its size — see verify-archive.ts for what
    // each one catches and why the pair of checks that used to be here passed a
    // truncated dump as `completed`.
    const size = await verifyArchive(gzip, filepath);

    // 0600: the file holds the whole database, password hashes and customer data
    // included, and the usual umask would leave it world-readable.
    if (process.platform !== 'win32') {
      // `chmod` from node:fs/promises, not `Bun.spawn(['chmod', …]).exited.catch()`.
      // `.exited` RESOLVES with the exit code and never rejects, so that `.catch`
      // caught nothing: a chmod that failed was indistinguishable from one that
      // worked, on a file holding the entire database. This rejects, and the
      // failure is fatal to the backup — a dump the umask left world-readable is
      // not a backup that succeeded.
      await chmod(filepath, 0o600);
    }

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

    // Upload AFTER the local dump is recorded complete, and never in a way that
    // can undo it.
    //
    // The two are separate facts: the dump exists on this disk, and a copy of it
    // does or does not exist elsewhere. Folding the second into the first would
    // report a perfectly good local backup as failed because a bucket was
    // unreachable — and an operator who believes last night failed behaves very
    // differently from one who knows the copy did.
    if (opts.destination === 's3' || opts.destination === 'both') {
      const up = await uploadBackup(db, {
        backupId,
        filepath,
        filename,
        prefix: opts.s3Prefix ?? null,
      });
      if (!up.uploaded) {
        console.error(`[backup] ${filename} was written locally but not uploaded: ${up.error}`);
      }
    }

    // Same prune the one-off "back up now" button already runs after a
    // success — without it a firing schedule has no cap on what it leaves
    // behind, on disk or in `zv_backups`. See `cleanupOldBackups` for why.
    await cleanupOldBackups(db);

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
