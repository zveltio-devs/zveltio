/**
 * Unit coverage for the cron/ai_task flow scheduler (flows/flow-scheduler.ts).
 *
 * The scheduler polls zv_flows for due cron/ai_task rows and dispatches them.
 * We drive it with CannedDb (answers the poll SELECT + records the next_run_at
 * UPDATE, no Postgres) and a fake `ai.runBackgroundTask` in serviceRegistry.
 *
 * The cron branch delegates to executeFlow() (a direct import over the real DB)
 * so it's out of scope here — this suite covers lifecycle (start/stop/status),
 * the poll tick, and the ai_task dispatch path (both with and without the AI
 * extension registered).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Database } from '../../db/index.js';
import { extensionRegistry } from '../../lib/extensions/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;
const FLOWS_UPDATE = /update "zv_flows"/i;

/** Inject a db into the module-scoped scheduler without leaving timers running. */
async function injectDb(db: CannedDb): Promise<void> {
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop(); // clears the poll/GC timers; _db stays set
}

let db: CannedDb;

beforeEach(() => {
  db = new CannedDb();
  db.when(FLOWS_SELECT, []); // default: nothing due
  db.when(FLOWS_UPDATE, []);
});

afterEach(() => {
  flowScheduler.stop();
  serviceRegistry.unregisterAs('test', 'ai.runBackgroundTask');
  _internalForTests.setExecuteFlowForTests(null);
});

describe('flowScheduler lifecycle', () => {
  it('reports running + active status after start, and clears on stop', async () => {
    await flowScheduler.start(db.kysely as unknown as Database);
    const running = flowScheduler.getStatus();
    expect(running.running).toBe(true);
    expect(running.active).toBe(true);

    flowScheduler.stop();
    expect(flowScheduler.getStatus().running).toBe(false);
  });

  it('is idempotent — a second start() while running is a no-op', async () => {
    await flowScheduler.start(db.kysely as unknown as Database);
    await flowScheduler.start(db.kysely as unknown as Database); // must not throw / double-schedule
    expect(flowScheduler.getStatus().running).toBe(true);
    flowScheduler.stop();
  });
});

describe('flowScheduler._tick', () => {
  it('polls zv_flows and dispatches a due ai_task flow', async () => {
    let calledWith: { userId: string; instruction: string } | null = null;
    serviceRegistry.registerAs(
      'test',
      'ai.runBackgroundTask',
      async (userId: string, instruction: string) => {
        calledWith = { userId, instruction };
      },
    );

    db.when(FLOWS_SELECT, [
      {
        id: 'flow-ai',
        name: 'Daily digest',
        trigger_type: 'ai_task',
        trigger_config: { user_id: 'u42', instruction: 'summarise', interval_seconds: 120 },
        created_by: 'u1',
      },
    ]);
    await injectDb(db);

    await flowScheduler._tick();
    // _executeScheduledFlow is fire-and-forget — let the microtasks flush.
    await new Promise((r) => setTimeout(r, 25));

    expect(calledWith).not.toBeNull();
    expect(calledWith!.userId).toBe('u42');
    expect(calledWith!.instruction).toBe('summarise');
    expect(db.executed(FLOWS_UPDATE).length).toBeGreaterThanOrEqual(1);
  });

  it('does nothing when no flows are due', async () => {
    await injectDb(db);
    await flowScheduler._tick();
    expect(db.executed(FLOWS_UPDATE).length).toBe(0);
  });

  it('polls zv_flows and dispatches a due cron flow', async () => {
    let executedId = '';
    _internalForTests.setExecuteFlowForTests(async (_db, flowId) => {
      executedId = flowId;
      return { status: 'success', runId: 'run-1', output: {} };
    });
    db.when(FLOWS_SELECT, [
      {
        id: 'flow-cron',
        name: 'Nightly',
        trigger_type: 'cron',
        trigger_config: { interval_seconds: 300 },
        created_by: 'u1',
      },
    ]);
    await injectDb(db);
    await flowScheduler._tick();
    await new Promise((r) => setTimeout(r, 25));
    expect(executedId).toBe('flow-cron');
    expect(db.executed(FLOWS_UPDATE).length).toBeGreaterThanOrEqual(1);
  });
});

describe('flowScheduler._executeScheduledFlow (ai_task)', () => {
  const aiFlow = {
    id: 'flow-ai',
    name: 'AI Flow',
    trigger_type: 'ai_task',
    trigger_config: { user_id: 'u7', instruction: 'do it', notify_on_result: false },
    created_by: 'creator',
  };

  it('runs the AI background task and advances next_run_at', async () => {
    const calls: unknown[][] = [];
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async (...args: unknown[]) => {
      calls.push(args);
    });
    await injectDb(db);

    await flowScheduler._executeScheduledFlow(aiFlow);

    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('u7'); // cfg.user_id
    expect(calls[0][1]).toBe('do it'); // cfg.instruction
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });

  it('skips gracefully when the AI extension is not registered, but still advances next_run_at', async () => {
    // no ai.runBackgroundTask registered
    await injectDb(db);
    await flowScheduler._executeScheduledFlow(aiFlow);
    // no throw; the schedule still advances so it doesn't busy-loop
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });

  it('does not throw when the AI task itself rejects', async () => {
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => {
      throw new Error('model unavailable');
    });
    await injectDb(db);
    // The error is caught + logged; next_run_at still advances.
    await flowScheduler._executeScheduledFlow(aiFlow);
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });
});

describe('flowScheduler._executeScheduledFlow (cron)', () => {
  const cronFlow = {
    id: 'flow-cron',
    name: 'Cron Flow',
    trigger_type: 'cron',
    trigger_config: { interval_seconds: 120 },
    created_by: 'creator',
  };

  it('delegates to executeFlow and advances next_run_at', async () => {
    let executedId = '';
    _internalForTests.setExecuteFlowForTests(async (_db, flowId) => {
      executedId = flowId;
      return { status: 'success', runId: 'run-cron-1', output: {} };
    });
    await injectDb(db);
    await flowScheduler._executeScheduledFlow(cronFlow);
    expect(executedId).toBe('flow-cron');
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });

  it('still advances next_run_at when executeFlow reports failure', async () => {
    _internalForTests.setExecuteFlowForTests(async () => ({
      status: 'failed',
      runId: 'run-bad',
      output: {},
      error: 'step blew up',
    }));
    await injectDb(db);
    await flowScheduler._executeScheduledFlow(cronFlow);
    expect(db.executed(FLOWS_UPDATE).length).toBe(1);
  });
});

describe('scheduleTrashPurge (_internalForTests)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    extensionRegistry.registerTrashPurgeHandler(async () => {});
  });

  it('runs the registered trash purge handler at 03:30', async () => {
    let purged = false;
    extensionRegistry.registerTrashPurgeHandler(async () => {
      purged = true;
    });
    const canned = new CannedDb();
    jest.setSystemTime(new Date('2026-06-17T03:29:00'));
    const stop = _internalForTests.scheduleTrashPurge(canned.kysely as unknown as Database);
    jest.advanceTimersByTime(61_000);
    await Promise.resolve();
    expect(purged).toBe(true);
    stop();
  });
});
