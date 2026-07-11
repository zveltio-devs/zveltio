/**
 * CronRunnerImpl lifecycle (lib/runtime/cron-runner.ts) — start/stop/_tick dispatch.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CronRunnerImpl } from '../../lib/runtime/cron-runner.js';

function stubDb() {
  return {
    insertInto: () => ({
      values: () => ({ execute: async () => {} }),
    }),
    updateTable: () => ({
      set: () => ({ where: () => ({ execute: async () => {} }) }),
    }),
  } as unknown as Database;
}

afterEach(() => {
  // Ensure no interval leaks between tests.
});

describe('CronRunnerImpl start/stop/_tick', () => {
  it('start is idempotent and stop clears the polling timer', () => {
    const runner = new CronRunnerImpl();
    runner.register('ext', { name: 's', intervalMs: 60_000, handler: async () => {} });
    runner.start(stubDb(), {} as never);
    const firstTimer = (runner as unknown as { timer: ReturnType<typeof setInterval> | null })
      .timer;
    expect(firstTimer).not.toBeNull();
    runner.start(stubDb(), {} as never);
    expect((runner as unknown as { timer: ReturnType<typeof setInterval> | null }).timer).toBe(
      firstTimer,
    );
    runner.stop();
    expect(
      (runner as unknown as { timer: ReturnType<typeof setInterval> | null }).timer,
    ).toBeNull();
  });

  it('_tick runs due schedules and advances nextRunAt', async () => {
    const runner = new CronRunnerImpl();
    let calls = 0;
    runner.register('ext', {
      name: 'due',
      intervalMs: 60_000,
      handler: async () => {
        calls++;
      },
    });
    const entries = (
      runner as unknown as { entries: Map<string, { nextRunAt: number; inFlight: boolean }> }
    ).entries;
    const entry = entries.get('ext::due');
    expect(entry).toBeDefined();
    entry!.nextRunAt = 0;

    (runner as unknown as { db: Database | null }).db = stubDb();
    (runner as unknown as { ctx: unknown }).ctx = {};
    await (runner as unknown as { _tick: () => Promise<void> })._tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    expect(entry!.nextRunAt).toBeGreaterThan(Date.now() - 1000);
  });

  it('_tick skips schedules that are not yet due or already in flight', async () => {
    const runner = new CronRunnerImpl();
    let calls = 0;
    runner.register('ext', {
      name: 'future',
      intervalMs: 60_000,
      handler: async () => {
        calls++;
      },
    });
    const entries = (
      runner as unknown as { entries: Map<string, { nextRunAt: number; inFlight: boolean }> }
    ).entries;
    const entry = entries.get('ext::future');
    entry!.nextRunAt = Date.now() + 60_000;
    entry!.inFlight = true;

    (runner as unknown as { db: Database | null }).db = stubDb();
    (runner as unknown as { ctx: unknown }).ctx = {};
    await (runner as unknown as { _tick: () => Promise<void> })._tick();
    expect(calls).toBe(0);
  });
});
