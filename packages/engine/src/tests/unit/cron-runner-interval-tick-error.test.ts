/**
 * CronRunnerImpl — setInterval tick failures are logged, loop keeps running.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CronRunnerImpl } from '../../lib/runtime/cron-runner.js';

function stubDb() {
  return {
    insertInto: () => ({ values: () => ({ execute: async () => {} }) }),
    updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => {} }) }) }),
  } as unknown as Database;
}

afterEach(() => {
  // each test calls stop()
});

describe('CronRunnerImpl interval tick errors', () => {
  it('logs when a polling _tick rejects', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const runner = new CronRunnerImpl();
    runner.register('ext', { name: 's', intervalMs: 60_000, handler: async () => {} });

    let tickCalls = 0;
    (runner as unknown as { _tick: () => Promise<void> })._tick = async () => {
      tickCalls++;
      if (tickCalls > 1) throw new Error('interval tick failed');
    };

    let intervalFn: (() => void) | undefined;
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
      intervalFn = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      runner.start(stubDb(), {} as never);
      expect(intervalFn).toBeDefined();
      await intervalFn!();
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('tick failed'))).toBe(true);
    } finally {
      runner.stop();
      intervalSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
