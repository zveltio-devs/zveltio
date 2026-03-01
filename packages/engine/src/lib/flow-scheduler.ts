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

let _db: Database | null = null;
let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;

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
  },

  stop(): void {
    _running = false;
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
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
        .where('trigger_type', '=', 'cron')
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
