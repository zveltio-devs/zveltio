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

    // The trash purge arms a setTimeout for the next 03:30; stop() must cancel
    // exactly that timer, or restarts would pile purges up.
    const now = new Date();
    const at0330 = new Date(now);
    at0330.setHours(3, 30, 0, 0);
    if (at0330 <= now) at0330.setDate(at0330.getDate() + 1);
    const expectedDelay = at0330.getTime() - now.getTime();
    const armed: { handle: number; delay: number }[] = [];
    let nextHandle = 1000;
    const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      _fn: () => void,
      delay?: number,
    ) => {
      const handle = nextHandle++;
      armed.push({ handle, delay: delay ?? 0 });
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    try {
      await flowScheduler.start(db.kysely as unknown as Database);
      expect(gcSpy).toHaveBeenCalled();
      expect(flowScheduler.getStatus().active).toBe(true);

      const purge = armed.find((t) => Math.abs(t.delay - expectedDelay) < 5_000);
      expect(purge, 'no timer armed for the 03:30 trash purge').toBeDefined();

      flowScheduler.stop();
      expect(clearSpy.mock.calls.some((c) => c[0] === (purge!.handle as unknown))).toBe(true);
    } finally {
      flowScheduler.stop();
      gcSpy.mockRestore();
      tickSpy.mockRestore();
      intervalSpy.mockRestore();
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
