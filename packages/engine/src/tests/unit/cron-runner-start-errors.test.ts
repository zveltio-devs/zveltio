/**
 * CronRunnerImpl.start — initial tick failure is logged, loop keeps running.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CronRunnerImpl } from '../../lib/runtime/cron-runner.js';

afterEach(() => {
  // no-op — stop() in each test
});

describe('CronRunnerImpl.start error paths', () => {
  it('logs when the initial _tick rejects', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const runner = new CronRunnerImpl();
    runner.register('ext', { name: 's', intervalMs: 60_000, handler: async () => {} });
    const entry = (
      runner as unknown as { entries: Map<string, { nextRunAt: number }> }
    ).entries.get('ext::s');
    entry!.nextRunAt = 0;

    (runner as unknown as { _tick: () => Promise<void> })._tick = async () => {
      throw new Error('tick blew up');
    };

    try {
      runner.start({} as Database, {} as never);
      await Bun.sleep(30);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('initial tick failed'))).toBe(
        true,
      );
    } finally {
      runner.stop();
      errSpy.mockRestore();
    }
  });
});
