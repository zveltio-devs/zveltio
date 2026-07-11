/**
 * CronRunnerImpl — non-fatal DB logging failures (_insertRun / _finishRun).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { CronRunnerImpl } from '../../lib/runtime/cron-runner.js';

describe('CronRunnerImpl — run logging resilience', () => {
  it('continues when insertRun and finishRun DB writes throw', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new CronRunnerImpl();
    let handlerCalls = 0;
    (runner as unknown as { db: unknown }).db = {
      insertInto: () => ({
        values: () => ({
          execute: async () => {
            throw new Error('insert failed');
          },
        }),
      }),
      updateTable: () => ({
        set: () => ({
          where: () => ({
            execute: async () => {
              throw new Error('update failed');
            },
          }),
        }),
      }),
    };
    (runner as unknown as { ctx: unknown }).ctx = {};
    const entry = {
      ownerExt: 'ext',
      schedule: {
        name: 'job',
        intervalMs: 60_000,
        handler: async () => {
          handlerCalls++;
        },
      },
      nextRunAt: 0,
      inFlight: true,
    };
    try {
      await (runner as unknown as { _runOne: (e: typeof entry) => Promise<void> })._runOne(entry);
      expect(handlerCalls).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('failed to log run'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
