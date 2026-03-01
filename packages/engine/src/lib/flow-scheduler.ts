import type { Database } from '../db/index.js';

type FlowExecuteFn = (db: Database, flow: any, triggerData: any) => Promise<any>;

let _db: Database | null = null;
let _executeFn: FlowExecuteFn | null = null;
let _running = false;
let _timer: ReturnType<typeof setInterval> | null = null;

export const flowScheduler = {
  /**
   * Called by the automation/flows extension during register() to inject
   * the db instance and execution function. If never called, _tick() is a no-op.
   */
  setExecutor(db: Database, fn: FlowExecuteFn): void {
    _db = db;
    _executeFn = fn;
  },

  async start(): Promise<void> {
    if (_running) return;
    _running = true;
    // Immediate first tick, then every 60s
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

  getStatus(): { running: boolean; hasExecutor: boolean } {
    return { running: _running, hasExecutor: _executeFn !== null };
  },

  async _tick(): Promise<void> {
    if (!_db || !_executeFn) return; // extension not loaded — no-op

    try {
      const flows: any[] = await (_db as any)
        .selectFrom('zv_flows')
        .selectAll()
        .where('is_active', '=', true)
        .where('trigger_type', '=', 'cron')
        .execute()
        .catch(() => []);

      const now = new Date();
      for (const flow of flows) {
        const nextRun = flow.next_run_at ? new Date(flow.next_run_at) : null;
        if (!nextRun || nextRun <= now) {
          this._executeFlow(flow).catch(() => {});
        }
      }
    } catch { /* non-fatal — extension may not be active */ }
  },

  async _executeFlow(flow: any): Promise<void> {
    if (!_db || !_executeFn) return;

    const runId = crypto.randomUUID();
    try {
      await (_db as any)
        .insertInto('zv_flow_runs')
        .values({
          id: runId,
          flow_id: flow.id,
          trigger_data: JSON.stringify({ trigger: 'cron' }),
          status: 'running',
          started_at: new Date(),
        })
        .execute()
        .catch(() => {});

      const output = await _executeFn!(_db!, flow, { trigger: 'cron', flow_id: flow.id });

      await (_db as any)
        .updateTable('zv_flow_runs')
        .set({
          status: 'completed',
          finished_at: new Date(),
          output: JSON.stringify(output ?? {}),
        })
        .where('id', '=', runId)
        .execute()
        .catch(() => {});

      // Advance next_run_at (simple +60s; a real impl would parse the cron expression)
      await (_db as any)
        .updateTable('zv_flows')
        .set({
          last_run_at: new Date(),
          next_run_at: new Date(Date.now() + 60_000),
        })
        .where('id', '=', flow.id)
        .execute()
        .catch(() => {});
    } catch (err) {
      await (_db as any)
        .updateTable('zv_flow_runs')
        .set({
          status: 'failed',
          finished_at: new Date(),
          error: String(err),
        })
        .where('id', '=', runId)
        .execute()
        .catch(() => {});
    }
  },
};
