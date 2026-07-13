/**
 * flow-scheduler.ts — cron success telemetry (executing + completed logs).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_UPDATE = /update "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

afterEach(() => {
  flowScheduler.stop();
  _internalForTests.setExecuteFlowForTests(null);
});

describe('flowScheduler._executeScheduledFlow — cron telemetry', () => {
  it('logs when a cron flow starts and completes successfully', async () => {
    _internalForTests.setExecuteFlowForTests(async (_db, flowId) => ({
      status: 'success',
      runId: 'run-ok',
      output: {},
    }));
    const db = new CannedDb();
    db.when(FLOWS_UPDATE, []);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await injectDb(db);
      await flowScheduler._executeScheduledFlow({
        id: 'flow-ok',
        name: 'Nightly',
        trigger_type: 'cron',
        trigger_config: { interval_seconds: 120 },
        created_by: 'u1',
      });
      expect(log.mock.calls.some((c) => String(c[0]).includes('executing flow'))).toBe(true);
      expect(
        log.mock.calls.some((c) => {
          const meta = c[1] as { flow?: string; run?: string } | undefined;
          return String(c[0]).includes('flow completed') && meta?.flow === 'flow-ok';
        }),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});
