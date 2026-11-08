/**
 * Unit coverage for the cron flow scheduler (flows/flow-scheduler.ts).
 *
 * The scheduler polls zv_flows for due cron rows and dispatches them. We drive
 * it with CannedDb (answers the poll SELECT + records the next_run_at UPDATE,
 * no Postgres) and a stand-in for executeFlow().
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Database } from '../../db/index.js';
import { extensionRegistry } from '../../lib/extensions/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;
const FLOWS_UPDATE = /update "zv_flows"/i;

/** Inject a db into the module-scoped scheduler without leaving timers running. */
async function injectDb(db: CannedDb): Promise<void> {
  initTenantManager(db.kysely as unknown as Database);
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
  initTenantManager(null as unknown as Database);
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
  it('claims cron rows only — a stored `ai_task` row is never picked up (ADR 0027)', async () => {
    await injectDb(db);
    await flowScheduler._tick();
    const [poll] = db.executed(FLOWS_SELECT);
    expect(poll?.parameters).toContain('cron');
    expect(poll?.parameters).not.toContain('ai_task');
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

  // What this can prove is that 03:30 fires the purge. It cannot prove the purge
  // is per-tenant: the purge now goes through `withTenantIsolation`, which uses
  // the tenancy module's own handle rather than the one passed in, so a CannedDb
  // never reaches the handler. The per-tenant contract is asserted against a real
  // database in tests/harness/trash-purge-per-tenant.test.ts.
  //
  // The previous version of this test asserted the handler was called with the
  // raw engine handle — which WAS the defect: no tenant GUC, so the handler saw
  // only the default tenant and purged nothing for anybody else.
  it('fires the trash purge at 03:30', async () => {
    extensionRegistry.registerTrashPurgeHandler(async () => {});
    const canned = new CannedDb();
    canned.when(/from "zv_tenants"|FROM zv_tenants/i, []);
    jest.setSystemTime(new Date('2026-06-17T03:29:00'));
    const stop = _internalForTests.scheduleTrashPurge(canned.kysely as unknown as Database);
    jest.advanceTimersByTime(61_000);
    // Real timers from here: the purge's first query resolves through the
    // driver's own promises, and `waitFor` polls, so it cannot make progress
    // while the clock is frozen.
    jest.useRealTimers();
    // The tenant enumeration is the first thing the purge does, so its presence
    // in the log is the timer having fired.
    await canned.waitFor(/zv_tenants/i);
    stop();
  });
});
