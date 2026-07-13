/**
 * flow-scheduler.ts — _tick logs per-flow failures from _executeScheduledFlow.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;

async function injectDb(db: CannedDb): Promise<void> {
  await flowScheduler.start(db.kysely as unknown as Database);
  flowScheduler.stop();
}

afterEach(() => {
  flowScheduler.stop();
  _internalForTests.setExecuteFlowForTests(null);
});

describe('flowScheduler._tick — scheduled flow rejection', () => {
  it('logs when a due cron flow rejects inside _executeScheduledFlow', async () => {
    _internalForTests.setExecuteFlowForTests(async () => {
      throw new Error('executeFlow exploded');
    });
    const db = new CannedDb();
    db.when(FLOWS_SELECT, [
      {
        id: 'flow-boom',
        name: 'Boom',
        trigger_type: 'cron',
        trigger_config: { interval_seconds: 60 },
        created_by: 'u1',
      },
    ]);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await injectDb(db);
      await flowScheduler._tick();
      await new Promise((r) => setTimeout(r, 40));
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('_executeScheduledFlow failed')),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
