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
import { extensionRegistry } from './extension-registry.js';
import { ZveltioAIEngine } from './zveltio-ai/engine.js';

const SCHEDULER_POLL_MS = 60_000;        // How often the scheduler polls for due flows
const DEFAULT_CRON_INTERVAL_MS = 60_000; // Default interval when trigger_config.interval_seconds is absent
const DEFAULT_AI_INTERVAL_MS = 3_600_000; // Default interval for ai_task flows (1 h)

let _db: Database | null = null;
let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;
let _stopGC: (() => void) | null = null;
let _stopTrashPurge: (() => void) | null = null;

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

    // Immediate first tick, then every SCHEDULER_POLL_MS
    await this._tick().catch(() => {});
    _timer = setInterval(() => {
      this._tick().catch(() => {});
    }, SCHEDULER_POLL_MS);

    // Garbage collector — runs daily at 03:00
    if (_db) {
      _stopGC = scheduleGarbageCollector(_db);
      // Trash purge — runs daily at 03:30. Store the stopper so that stop()
      // can cancel the pending setTimeout and prevent multiple timers from
      // accumulating across restarts.
      _stopTrashPurge = scheduleTrashPurge(_db);
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
    if (_stopTrashPurge) {
      _stopTrashPurge();
      _stopTrashPurge = null;
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
        console.log(`[FlowScheduler] ai_task completed`, { flow: flow.id, name: flow.name });
      } catch (err: any) {
        console.error(`[FlowScheduler] ai_task failed`, { flow: flow.id, name: flow.name, error: err.message });
      }

      // Advance next_run_at
      const intervalMs = ((flow.trigger_config?.interval_seconds as number | undefined) ?? 0) * 1_000 || DEFAULT_AI_INTERVAL_MS;
      await (_db as any)
        .updateTable('zv_flows')
        .set({ last_run_at: new Date(), next_run_at: new Date(Date.now() + intervalMs) })
        .where('id', '=', flow.id)
        .execute()
        .catch(() => {});

      return; // Skip standard flow executor for ai_task
    }

    // ── Standard flow execution ───────────────────────────────────
    console.log(`[FlowScheduler] executing flow`, { flow: flow.id, name: flow.name });

    const result = await executeFlow(_db, flow.id, { trigger: 'cron', flow_id: flow.id });

    if (result.status === 'success') {
      console.log(`[FlowScheduler] flow completed`, { flow: flow.id, name: flow.name, run: result.runId });
    } else {
      console.error(`[FlowScheduler] flow failed`, { flow: flow.id, name: flow.name, run: result.runId, error: result.error });
    }

    // Advance next_run_at — use trigger_config.interval_seconds if set, else default
    const intervalMs = ((flow.trigger_config?.interval_seconds as number | undefined) ?? 0) * 1_000 || DEFAULT_CRON_INTERVAL_MS;
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
 * The actual purge is performed by whichever extension registers a handler
 * via extensionRegistry.registerTrashPurgeHandler().
 */
function scheduleTrashPurge(db: Database): () => void {
  let _timeout: ReturnType<typeof setTimeout> | null = null;
  let _stopped = false;

  function scheduleNext(): void {
    if (_stopped) return;
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    _timeout = setTimeout(async () => {
      if (_stopped) return;
      const handler = extensionRegistry.getTrashPurgeHandler();
      if (handler) {
        try {
          await handler(db);
        } catch (err) {
          console.error('[Trash] Error during trash purge:', err);
        }
      }
      scheduleNext();
    }, next.getTime() - now.getTime());
  }

  scheduleNext();

  // Returns a stopper so flowScheduler.stop() can cancel the pending timeout.
  return () => {
    _stopped = true;
    if (_timeout) {
      clearTimeout(_timeout);
      _timeout = null;
    }
  };
}
