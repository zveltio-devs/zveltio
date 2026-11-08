/**
 * flow-scheduler.ts — next_run_at advance failure logs.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { initTenantManager } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_UPDATE = /update "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  initTenantManager(db.kysely as unknown as Database);
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

afterEach(() => {
  flowScheduler.stop();
  initTenantManager(null as unknown as Database);
  _internalForTests.setExecuteFlowForTests(null);
});

describe('flowScheduler — advance next_run_at failure logs', () => {
  it('logs when cron flow next_run_at update fails', async () => {
    _internalForTests.setExecuteFlowForTests(async () => ({
      status: 'success',
      runId: 'run-1',
      output: {},
    }));
    const db = new CannedDb();
    db.fail(FLOWS_UPDATE, new Error('update denied'));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await injectDb(db);
      await flowScheduler._executeScheduledFlow({
        id: 'cron-adv-fail',
        name: 'Cron',
        trigger_type: 'cron',
        trigger_config: { interval_seconds: 60 },
        created_by: 'u1',
      });
      expect(
        errSpy.mock.calls.some((c) => {
          const meta = c[1] as { flow?: string; error?: string } | undefined;
          return (
            String(c[0]).includes('failed to advance next_run_at') && meta?.flow === 'cron-adv-fail'
          );
        }),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
