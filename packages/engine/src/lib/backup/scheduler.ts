/**
 * The thing that makes a backup schedule a schedule.
 *
 * Until now `zv_backup_schedules` stored a cron expression that nothing read.
 * A row looked exactly like a working nightly backup — the API answered 201, the
 * audit log recorded `backup.scheduled`, the UI listed it — and nothing ever
 * ran. No installer closed the gap either: `install/install.sh` writes a systemd
 * unit for the engine and the word "backup" does not appear in it.
 *
 * ── Why in-process rather than a system cron ────────────────────
 *
 * The obvious alternative is for the installer to drop a crontab entry and for
 * the admin UI to edit it. That would mean the engine writing to `/etc/cron.d`,
 * which is the process that serves HTTP gaining the ability to run commands as
 * root. This codebase spent a lot of effort going the other way — see
 * `scripts/bootstrap-db-role.sh`, whose entire point is that the engine is not a
 * superuser.
 *
 * In-process needs none of that: the UI edits rows, which is what a UI should
 * do, and the engine reads them. It is also the pattern already here —
 * `scheduleGarbageCollector` and `scheduleTrashPurge` are started the same way
 * from `flowScheduler.start()`.
 *
 * The cost is honest and worth stating: a schedule only fires while an engine is
 * running. A machine that is off at 03:00 misses that night, and there is no
 * catch-up — see `SKIP_MISSED` below.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { nextCronRun } from '../flows/index.js';
import { type DumpTarget, runScheduledBackup } from './run-scheduled-backup.js';

/**
 * How often to look for due schedules.
 *
 * One minute, because cron's own resolution is one minute and a coarser tick
 * would silently round every schedule. The query is one indexed read against a
 * table that holds a handful of rows.
 */
const TICK_MS = 60_000;

/**
 * A schedule whose time passed while the engine was down runs at the next tick,
 * ONCE, not once per missed occurrence.
 *
 * The alternative — replaying every missed slot — turns a weekend of downtime
 * into a burst of full database dumps at boot, which is the moment a machine can
 * least afford them.
 */
const SKIP_MISSED = true;

interface DueRow {
  id: string;
  name: string;
  cron_expression: string;
  next_run_at: Date | null;
  storage_destination: 'local' | 's3' | 'both';
  s3_prefix: string | null;
}

/**
 * Compute and store the next occurrence for a schedule.
 *
 * Exported because creating or editing a schedule must set it too — a row whose
 * `next_run_at` is NULL would never become due, which is precisely the state
 * every existing row is in.
 */
export async function setNextRun(
  db: Database,
  scheduleId: string,
  cronExpression: string,
  from: Date = new Date(),
): Promise<Date | null> {
  const next = nextCronRun(cronExpression, from);
  await sql`
    UPDATE zv_backup_schedules SET next_run_at = ${next}, updated_at = NOW()
    WHERE id = ${scheduleId}
  `.execute(db);
  return next;
}

/**
 * Start the loop. Returns a stopper, like the other schedulers here.
 */
export function scheduleBackups(db: Database, resolveTarget: () => DumpTarget): () => void {
  // A chained `setTimeout`, not `setInterval` — the shape `scheduleTrashPurge`
  // and `scheduleGarbageCollector` already use here.
  //
  // It also keeps ticks from overlapping: the next one is armed after the last
  // finishes, so a dump that runs longer than the interval delays the following
  // check instead of stacking a second one behind it. `setInterval` would have
  // queued them.
  //
  // (There is a second reason, found by a test rather than by thinking:
  // `flow-scheduler-cron-failed` mocks `setInterval` globally and keeps whichever
  // callback was registered LAST. A second `setInterval` in this file silently
  // stole that capture and the test started asserting against the wrong tick.)
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  /** Ids currently running, so a slow dump cannot be started twice. */
  const running = new Set<string>();

  async function tick(): Promise<void> {
    if (stopped) return;

    let due: DueRow[];
    try {
      const rows = await sql<DueRow>`
        SELECT id::text, name, cron_expression, next_run_at,
               storage_destination, s3_prefix
          FROM zv_backup_schedules
         WHERE is_active = true
           AND next_run_at IS NOT NULL
           AND next_run_at <= NOW()
         ORDER BY next_run_at
      `.execute(db);
      due = rows.rows;
    } catch (err) {
      // A tick that cannot read the table must not kill the loop: the database
      // may be restarting, and the next tick is a minute away.
      console.error('[backup-scheduler] could not read schedules:', err);
      return;
    }

    for (const s of due) {
      if (stopped) return;

      // Move the marker BEFORE running, not after.
      //
      // A dump can take longer than a tick. If the next occurrence were written
      // afterwards, the following tick would find the same row still due and
      // start a second dump of the same database — the `running` guard below
      // stops that within one process, but a restart mid-dump would not be
      // covered by it. Advancing first means the worst case is a missed run,
      // not a duplicated one.
      const next = await setNextRun(db, s.id, s.cron_expression, new Date()).catch((err) => {
        console.error(`[backup-scheduler] ${s.id}: could not set next_run_at:`, err);
        return null;
      });
      if (next === null) {
        // An unparseable cron expression would otherwise be retried every minute
        // forever. Deactivate it and say so — loudly, because the operator
        // believes this schedule is running.
        await sql`
          UPDATE zv_backup_schedules SET is_active = false, last_run_status = 'invalid_cron'
          WHERE id = ${s.id}
        `
          .execute(db)
          .catch(() => {});
        console.error(
          `[backup-scheduler] "${s.name}" has an unusable cron expression ` +
            `(${s.cron_expression}) and has been deactivated. No backup will run for it.`,
        );
        continue;
      }

      if (running.has(s.id)) {
        console.warn(`[backup-scheduler] "${s.name}" is still running; skipping this occurrence.`);
        continue;
      }

      running.add(s.id);
      try {
        const out = await runScheduledBackup(db, {
          scheduleId: s.id,
          scheduleName: s.name,
          target: resolveTarget(),
          actorId: null,
          note: `Scheduled: ${s.name}`,
          destination: s.storage_destination,
          s3Prefix: s.s3_prefix,
        });
        console.log(
          `[backup-scheduler] "${s.name}" ${out.status}` +
            (out.error ? ` — ${out.error.split('\n')[0]}` : '') +
            `; next at ${next.toISOString()}`,
        );
      } finally {
        running.delete(s.id);
      }
    }
  }

  /**
   * Give every active schedule a `next_run_at` at startup.
   *
   * Every row in every existing install has NULL there — nothing ever computed
   * it — so without this the scheduler would start and find nothing due, for
   * ever, which is indistinguishable from the bug it fixes.
   */
  async function primeAtStart(): Promise<void> {
    try {
      const rows = await sql<{ id: string; cron_expression: string }>`
        SELECT id::text, cron_expression FROM zv_backup_schedules
         WHERE is_active = true AND next_run_at IS NULL
      `.execute(db);
      let primed = 0;
      for (const r of rows.rows) {
        const next = await setNextRun(db, r.id, r.cron_expression).catch(() => null);
        if (next) {
          primed++;
          continue;
        }
        // An expression that cannot be parsed leaves `next_run_at` NULL, and the
        // due query skips NULL — so the row would sit there active and never
        // run, for ever, without ever being mentioned again. The API warns once
        // at creation; nobody reads that warning a month later.
        //
        // Deactivating it is what makes the state visible: an operator looking
        // at the list sees a schedule that is off with a reason, rather than one
        // that is on and idle.
        await sql`
          UPDATE zv_backup_schedules SET is_active = false, last_run_status = 'invalid_cron'
          WHERE id = ${r.id}
        `
          .execute(db)
          .catch(() => {});
        console.error(
          `[backup-scheduler] schedule ${r.id} has an unusable cron expression ` +
            `(${r.cron_expression}) and has been deactivated. No backup will run for it.`,
        );
      }
      if (primed > 0) {
        console.log(`[backup-scheduler] primed ${primed} schedule(s) with a next run.`);
      }
    } catch (err) {
      console.error('[backup-scheduler] could not prime schedules:', err);
    }
  }

  function armNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(armNext);
    }, TICK_MS);
  }

  void primeAtStart()
    .then(() => (!stopped && SKIP_MISSED ? tick() : undefined))
    .finally(armNext);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
