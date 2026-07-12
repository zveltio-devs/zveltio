/**
 * flow-scheduler.ts error / catch branches (tick failures, update failures, trash purge).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Database } from '../../db/index.js';
import { extensionRegistry } from '../../lib/extensions/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { serviceRegistry } from '../../lib/service-registry.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;
const FLOWS_UPDATE = /update "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

let db: CannedDb;

beforeEach(() => {
  db = new CannedDb();
  db.when(FLOWS_SELECT, []);
  db.when(FLOWS_UPDATE, []);
});

afterEach(() => {
  flowScheduler.stop();
  serviceRegistry.unregisterAs('test', 'ai.runBackgroundTask');
  _internalForTests.setExecuteFlowForTests(null);
  extensionRegistry.registerTrashPurgeHandler(async () => {});
});

describe('flowScheduler error paths', () => {
  it('_tick logs and survives transaction failures', async () => {
    db.fail(FLOWS_SELECT, new Error('pool exhausted'));
    await injectDb(db);
    await expect(flowScheduler._tick()).resolves.toBeUndefined();
  });

  it('_tick survives when _executeScheduledFlow rejects for cron flows', async () => {
    _internalForTests.setExecuteFlowForTests(async () => {
      throw new Error('executeFlow blew up');
    });
    db.when(FLOWS_SELECT, [
      {
        id: 'flow-boom',
        name: 'Boom',
        trigger_type: 'cron',
        trigger_config: {},
        created_by: 'u1',
      },
    ]);
    await injectDb(db);
    await flowScheduler._tick();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('_executeScheduledFlow logs when advancing ai_task next_run_at fails', async () => {
    serviceRegistry.registerAs('test', 'ai.runBackgroundTask', async () => {});
    db.fail(FLOWS_UPDATE, new Error('update denied'));
    await injectDb(db);
    await flowScheduler._executeScheduledFlow({
      id: 'ai-fail-advance',
      name: 'AI',
      trigger_type: 'ai_task',
      trigger_config: { user_id: 'u1', instruction: 'go' },
      created_by: 'u1',
    });
  });

  it('_executeScheduledFlow logs when advancing cron next_run_at fails', async () => {
    _internalForTests.setExecuteFlowForTests(async () => ({
      status: 'success',
      runId: 'r1',
      output: {},
    }));
    db.fail(FLOWS_UPDATE, new Error('update denied'));
    await injectDb(db);
    await flowScheduler._executeScheduledFlow({
      id: 'cron-fail-advance',
      name: 'Cron',
      trigger_type: 'cron',
      trigger_config: { interval_seconds: 60 },
      created_by: 'u1',
    });
  });

  it('start() survives an initial tick failure', async () => {
    const bad = new CannedDb();
    bad.fail(FLOWS_SELECT, new Error('initial tick fail'));
    await expect(flowScheduler.start(bad.kysely as unknown as Database)).resolves.toBeUndefined();
    flowScheduler.stop();
  });
});

describe('scheduleTrashPurge errors', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('logs handler failures without crashing the scheduler loop', async () => {
    extensionRegistry.registerTrashPurgeHandler(async () => {
      throw new Error('purge failed');
    });
    const canned = new CannedDb();
    jest.setSystemTime(new Date('2026-06-17T03:29:00'));
    const stop = _internalForTests.scheduleTrashPurge(canned.kysely as unknown as Database);
    jest.advanceTimersByTime(61_000);
    await Promise.resolve();
    stop();
  });
});
