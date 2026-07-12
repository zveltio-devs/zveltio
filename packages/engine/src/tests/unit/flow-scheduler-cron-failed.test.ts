/**
 * flow-scheduler.ts — cron failure logging + interval tick error path.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler, _internalForTests } from '../../lib/flows/flow-scheduler.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;
const FLOWS_UPDATE = /update "zv_flows"/i;

let db: CannedDb;

beforeEach(() => {
  db = new CannedDb();
  db.when(FLOWS_SELECT, []);
  db.when(FLOWS_UPDATE, []);
});

afterEach(() => {
  flowScheduler.stop();
  _internalForTests.setExecuteFlowForTests(null);
});

describe('flowScheduler — cron failure logging', () => {
  it('logs when executeFlow returns a failed status', async () => {
    _internalForTests.setExecuteFlowForTests(async () => ({
      status: 'failed',
      runId: 'run-bad',
      output: {},
      error: 'step exploded',
    }));
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await flowScheduler.start(db.kysely as unknown as Database);
      await flowScheduler._executeScheduledFlow({
        id: 'flow-fail',
        name: 'FailFlow',
        trigger_type: 'cron',
        trigger_config: { interval_seconds: 120 },
        created_by: 'u1',
      });
      expect(
        errSpy.mock.calls.some(
          (c) => String(c[0]).includes('flow failed') || String(c[1]).includes('step exploded'),
        ),
      ).toBe(true);
    } finally {
      flowScheduler.stop();
      errSpy.mockRestore();
    }
  });

  it('logs when a polling tick rejects', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let tickCalls = 0;
    const tickSpy = spyOn(flowScheduler, '_tick').mockImplementation(async () => {
      tickCalls++;
      if (tickCalls > 1) throw new Error('interval tick failed');
    });

    let intervalFn: (() => void) | undefined;
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      intervalFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      await flowScheduler.start(db.kysely as unknown as Database);
      expect(intervalFn).toBeDefined();
      await intervalFn!();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('tick failed'))).toBe(true);
    } finally {
      flowScheduler.stop();
      tickSpy.mockRestore();
      intervalSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
