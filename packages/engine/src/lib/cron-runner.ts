/**
 * Native extension schedules (S2-05).
 *
 * An extension declares `schedules()` returning an array of definitions; the
 * runner polls every 30 s and executes each schedule whose `nextRunAt` is
 * due. Persistence of every run (started, finished, failed, retried, dlq)
 * happens in `zv_extension_schedule_runs`.
 *
 * Timing options exposed to extensions (pick ONE per schedule):
 *   - `intervalMs`: re-runs every N milliseconds from the previous start.
 *   - `at`: runs once a day at `{ hour, minute }` in the server's timezone.
 *
 * Cron expressions are not supported in this iteration — `cron: 'expr'` on a
 * schedule is logged as an unsupported field and the schedule is skipped.
 *
 * Cross-process coordination: in-process only. Multiple engine replicas all
 * run the same schedule until a distributed lock is added (tracked as
 * follow-up). For now self-hosted single-engine is the assumption.
 */

import type { Database } from '../db/index.js';
import type { ExtensionContext } from './extension-loader.js';

export interface ExtensionSchedule {
  /** Unique within the owning extension. Stable across restarts (used as a key). */
  name: string;
  /** Re-run every N milliseconds. Set EITHER intervalMs OR at. */
  intervalMs?: number;
  /** Daily at `{ hour, minute }` in the server's local timezone. */
  at?: { hour: number; minute: number };
  /** Reserved for future cron syntax. Unsupported today; logged + skipped. */
  cron?: string;
  /** Async work to perform. `runId` is the row id in zv_extension_schedule_runs. */
  handler: (ctx: ExtensionContext, runId: string) => Promise<void>;
  /** Retry policy. Defaults: maxAttempts=1, backoffMs=1000. */
  retry?: { maxAttempts?: number; backoffMs?: number };
  /** Reserved — currently no cross-instance lock. Documented behaviour. */
  singleton?: boolean;
}

interface RunnerEntry {
  ownerExt: string;
  schedule: ExtensionSchedule;
  nextRunAt: number; // epoch ms
  inFlight: boolean;
}

const POLL_MS = 30_000;
const DEFAULT_RETRY = { maxAttempts: 1, backoffMs: 1000 };

/**
 * Compute the next epoch-ms run time for a schedule, given `now`.
 *
 * - intervalMs: `now + intervalMs`.
 * - at: today at HH:MM if still in the future, otherwise tomorrow at HH:MM.
 *
 * Returns null if neither intervalMs nor at is specified (caller skips).
 */
export function computeNextRun(
  schedule: Pick<ExtensionSchedule, 'intervalMs' | 'at'>,
  now: Date,
): number | null {
  if (typeof schedule.intervalMs === 'number' && schedule.intervalMs > 0) {
    return now.getTime() + schedule.intervalMs;
  }
  if (schedule.at) {
    const next = new Date(now);
    next.setHours(schedule.at.hour, schedule.at.minute, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }
  return null;
}

export class CronRunnerImpl {
  private entries = new Map<string, RunnerEntry>();
  private db: Database | null = null;
  private ctx: ExtensionContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /**
   * Register a single schedule. Idempotent on (ext, name) — replacing the
   * definition resets the next-run clock. Skips schedules with neither
   * intervalMs nor at (and logs a warning).
   */
  register(extName: string, schedule: ExtensionSchedule): void {
    if (schedule.cron) {
      console.warn(
        `[cron-runner] extension "${extName}" schedule "${schedule.name}" uses cron expression — ` +
        `not yet supported; the schedule will be skipped. Use intervalMs or at instead.`,
      );
      return;
    }
    const next = computeNextRun(schedule, new Date());
    if (next === null) {
      console.warn(
        `[cron-runner] extension "${extName}" schedule "${schedule.name}" has no intervalMs or at — skipped.`,
      );
      return;
    }
    const key = `${extName}::${schedule.name}`;
    this.entries.set(key, {
      ownerExt: extName,
      schedule,
      nextRunAt: next,
      inFlight: false,
    });
  }

  /** Remove every schedule owned by an extension. Called on unload. */
  unregisterAll(extName: string): number {
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.ownerExt === extName) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  count(extName?: string): number {
    if (!extName) return this.entries.size;
    let n = 0;
    for (const e of this.entries.values()) if (e.ownerExt === extName) n++;
    return n;
  }

  list(): Array<{ ownerExt: string; name: string; nextRunAt: number }> {
    return [...this.entries.values()].map((e) => ({
      ownerExt: e.ownerExt,
      name: e.schedule.name,
      nextRunAt: e.nextRunAt,
    }));
  }

  /** Test helper. */
  clear(): void {
    this.entries.clear();
  }

  /** Start polling. Requires `db` (for run logging) and a base `ctx` to hand to handlers. */
  start(db: Database, ctx: ExtensionContext): void {
    if (this.running) return;
    this.db = db;
    this.ctx = ctx;
    this.running = true;
    // First tick immediately, then every POLL_MS.
    this._tick().catch(() => { /* swallow */ });
    this.timer = setInterval(() => {
      this._tick().catch(() => { /* swallow */ });
    }, POLL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async _tick(): Promise<void> {
    if (!this.db || !this.ctx) return;
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.inFlight) continue;
      if (entry.nextRunAt > now) continue;
      // Schedule the run async so one slow handler doesn't delay others.
      entry.inFlight = true;
      this._runOne(entry).finally(() => {
        entry.inFlight = false;
        const next = computeNextRun(entry.schedule, new Date());
        if (next !== null) entry.nextRunAt = next;
      });
    }
  }

  async _runOne(entry: RunnerEntry): Promise<void> {
    if (!this.db || !this.ctx) return;
    const policy = { ...DEFAULT_RETRY, ...(entry.schedule.retry ?? {}) };
    const maxAttempts = Math.max(1, policy.maxAttempts);
    const backoffMs = Math.max(0, policy.backoffMs);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const runId = crypto.randomUUID();
      try {
        await this._insertRun(runId, entry.ownerExt, entry.schedule.name, attempt, 'running');
        await entry.schedule.handler(this.ctx, runId);
        await this._finishRun(runId, 'ok');
        return;
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        const isLast = attempt === maxAttempts;
        await this._finishRun(runId, isLast ? 'dlq' : 'failed', errMsg);
        console.warn(
          `[cron-runner] ${entry.ownerExt}::${entry.schedule.name} attempt ${attempt}/${maxAttempts} failed: ${errMsg}`,
        );
        if (!isLast && backoffMs > 0) {
          await Bun.sleep(backoffMs);
        }
      }
    }
  }

  async _insertRun(
    id: string,
    extName: string,
    scheduleName: string,
    attempt: number,
    status: 'running',
  ): Promise<void> {
    if (!this.db) return;
    try {
      await (this.db as any)
        .insertInto('zv_extension_schedule_runs')
        .values({
          id,
          extension_name: extName,
          schedule_name: scheduleName,
          started_at: new Date(),
          status,
          attempt,
        })
        .execute();
    } catch (err) {
      console.warn(`[cron-runner] failed to log run start: ${(err as Error).message}`);
    }
  }

  async _finishRun(
    id: string,
    status: 'ok' | 'failed' | 'dlq',
    errorMessage?: string,
  ): Promise<void> {
    if (!this.db) return;
    try {
      await (this.db as any)
        .updateTable('zv_extension_schedule_runs')
        .set({
          finished_at: new Date(),
          status,
          error_message: errorMessage ?? null,
        })
        .where('id' as any, '=', id)
        .execute();
    } catch (err) {
      console.warn(`[cron-runner] failed to log run finish: ${(err as Error).message}`);
    }
  }
}

export const cronRunner = new CronRunnerImpl();
