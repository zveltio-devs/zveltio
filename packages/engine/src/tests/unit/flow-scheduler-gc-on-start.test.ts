/**
 * flowScheduler.start — wires garbage collector + trash purge when db is set.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { flowScheduler } from '../../lib/flows/flow-scheduler.js';
import * as runtime from '../../lib/runtime/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const FLOWS_SELECT = /select[\s\S]*from "zv_flows"/i;

afterEach(() => {
  flowScheduler.stop();
});

describe('flowScheduler.start — background maintenance', () => {
  it('registers garbage collector and trash purge stoppers when a db is provided', async () => {
    const db = new CannedDb();
    db.when(FLOWS_SELECT, []);

    const gcSpy = spyOn(runtime, 'scheduleGarbageCollector').mockReturnValue(() => {});
    const tickSpy = spyOn(flowScheduler, '_tick').mockResolvedValue(undefined);
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      void fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      await flowScheduler.start(db.kysely as unknown as Database);
      expect(gcSpy).toHaveBeenCalled();
      expect(flowScheduler.getStatus().active).toBe(true);
    } finally {
      flowScheduler.stop();
      gcSpy.mockRestore();
      tickSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });
});
