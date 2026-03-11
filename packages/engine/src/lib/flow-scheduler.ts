/**
 * Flow Scheduler — polls for cron-triggered flows that are due and executes them.
 *
 * Uses a simple 60-second interval and compares `next_run_at` against NOW().
 * After each execution, `next_run_at` is advanced by trigger_config.interval_seconds
 * (defaults to 60 s). Step execution is delegated to flow-executor.ts so that
 * manual triggers (flows.ts POST /:id/run) and cron triggers share identical behaviour.
 */

import type { Database } from '../db/index.js';
import { executeFlow } from './flow-executor.js';
import { scheduleGarbageCollector } from './garbage-collector.js';
import { purgeExpiredTrash } from './cloud/trash.js';
import { createCloudS3Client } from '../routes/cloud.js';

let _db: Database | null = null;
let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;
let _stopGC: (() => void) | null = null;

export const flowScheduler = {
  /**
   * Start the scheduling loop.
   * Optionally accepts a db reference; if omitted the scheduler uses whatever
   * was previously set (for extension back-compat).
   */
  async start(db?: Database): Promise<void> {
    if (_running) return;
    if (db) _db = db;
    _running = true;

    // Immediate first tick, then every 60 s
    await this._tick().catch(() => {});
    _timer = setInterval(() => {
      this._tick().catch(() => {});
    }, 60_000);

    // Garbage collector — runs daily at 03:00
    if (_db) {
      _stopGC = scheduleGarbageCollector(_db);
      // Trash purge — runs daily at 03:30
      scheduleTrashPurge(_db);
    }
  },

  stop(): void {
    _running = false;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    if (_stopGC) {
      _stopGC();
      _stopGC = null;
    }
  },

  getStatus(): { running: boolean; active: boolean } {
    return { running: _running, active: _db !== null };
  },

  async _tick(): Promise<void> {
    if (!_db) return;

    try {
      const now = new Date();
      const flows: any[] = await (_db as any)
        .selectFrom('zv_flows')
        .selectAll()
        .where('is_active', '=', true)
        .where((eb: any) => eb('trigger_type', 'in', ['cron', 'ai_task']))
        .execute()
        .catch(() => []);

      for (const flow of flows) {
        const nextRun = flow.next_run_at ? new Date(flow.next_run_at) : null;
        if (!nextRun || nextRun <= now) {
          this._executeScheduledFlow(flow).catch(() => {});
        }
      }
    } catch { /* non-fatal */ }
  },

  async _executeScheduledFlow(flow: any): Promise<void> {
    if (!_db) return;

    // ── AI Task trigger ───────────────────────────────────────────
    if (flow.trigger_type === 'ai_task') {
      try {
        const { ZveltioAIEngine } = await import(
          '../../../extensions/ai/core-ai/engine/zveltio-ai/engine.js'
        ).catch(() => ({ ZveltioAIEngine: null as any }));

        if (!ZveltioAIEngine) {
          console.warn('[FlowScheduler] AI extension not loaded — skipping ai_task flow');
          // Advance next_run_at even on skip, otherwise retries every 60s indefinitely
          const skipIntervalMs = ((flow.trigger_config?.interval_seconds ?? 3600) as number) * 1_000;
          await (_db as any)
            .updateTable('zv_flows')
            .set({ last_run_at: new Date(), next_run_at: new Date(Date.now() + skipIntervalMs) })
            .where('id', '=', flow.id)
            .execute()
            .catch(() => {});
          return;
        }

        const engine = new ZveltioAIEngine(_db);
        const cfg = flow.trigger_config ?? {};

        await engine.processBackgroundTask(
          cfg.user_id ?? flow.created_by,
          cfg.instruction ?? flow.description ?? 'Generate a status report',
          {
            notifyOnResult: cfg.notify_on_result ?? true,
            notifyOnlyIfData: cfg.notify_only_if_data ?? false,
            notificationTitle: cfg.notification_title ?? flow.name,
            maxIterations: cfg.max_iterations ?? 5,
          },
        );

        console.log(`✅ FlowScheduler: AI task "${flow.name}" completed`);
      } catch (err: any) {
        console.error(`❌ FlowScheduler: AI task "${flow.name}" failed:`, err.message);
      }

      // Advance next_run_at
      const intervalMs = ((flow.trigger_config?.interval_seconds ?? 3600) as number) * 1_000;
      await (_db as any)
        .updateTable('zv_flows')
        .set({ last_run_at: new Date(), next_run_at: new Date(Date.now() + intervalMs) })
        .where('id', '=', flow.id)
        .execute()
        .catch(() => {});

      return; // Skip standard flow executor for ai_task
    }

    // ── Standard flow execution ───────────────────────────────────
    console.log(`⚡ FlowScheduler: executing "${flow.name}"`);

    const result = await executeFlow(_db, flow.id, { trigger: 'cron', flow_id: flow.id });

    if (result.status === 'success') {
      console.log(`⚡ FlowScheduler: "${flow.name}" completed`);
    } else {
      console.error(`⚡ FlowScheduler: "${flow.name}" failed:`, result.error);
    }

    // Advance next_run_at — use trigger_config.interval_seconds if set, else 60 s
    const intervalMs = ((flow.trigger_config?.interval_seconds ?? 60) as number) * 1_000;
    await (_db as any)
      .updateTable('zv_flows')
      .set({
        last_run_at: new Date(),
        next_run_at: new Date(Date.now() + intervalMs),
      })
      .where('id', '=', flow.id)
      .execute()
      .catch(() => {});
  },
};

/**
 * Schedules the cloud trash purge to run daily at 03:30.
 * Mirrors the GC pattern in garbage-collector.ts.
 */
function scheduleTrashPurge(db: Database): void {
  function scheduleNext(): void {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 30, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    const msUntil = next.getTime() - now.getTime();

    setTimeout(async () => {
      try {
        const s3 = createCloudS3Client();
        await purgeExpiredTrash(db, s3);
      } catch (err) {
        console.error('[Trash] Error during trash purge:', err);
      }
      scheduleNext();
    }, msUntil);
  }

  scheduleNext();
}
