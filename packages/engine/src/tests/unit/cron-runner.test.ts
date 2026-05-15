import { describe, it, expect, beforeEach } from 'bun:test';
import { computeNextRun, CronRunnerImpl } from '../../lib/cron-runner.js';

describe('computeNextRun', () => {
  it('returns now + intervalMs for interval schedules', () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const next = computeNextRun({ intervalMs: 60_000 }, now);
    expect(next).toBe(now.getTime() + 60_000);
  });

  it('returns today HH:MM if still in the future', () => {
    const now = new Date('2026-05-15T08:30:00');
    const next = computeNextRun({ at: { hour: 18, minute: 0 } }, now);
    const expected = new Date(now);
    expected.setHours(18, 0, 0, 0);
    expect(next).toBe(expected.getTime());
  });

  it('rolls over to tomorrow if HH:MM is already past', () => {
    const now = new Date('2026-05-15T20:00:00');
    const next = computeNextRun({ at: { hour: 9, minute: 0 } }, now);
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    expect(next).toBe(expected.getTime());
  });

  it('returns null when neither intervalMs nor at is set', () => {
    expect(computeNextRun({}, new Date())).toBeNull();
  });

  it('ignores zero/negative intervalMs (treated as absent)', () => {
    expect(computeNextRun({ intervalMs: 0 }, new Date())).toBeNull();
    expect(computeNextRun({ intervalMs: -10 }, new Date())).toBeNull();
  });
});

describe('CronRunnerImpl — register/unregister', () => {
  let runner: CronRunnerImpl;

  beforeEach(() => {
    runner = new CronRunnerImpl();
  });

  it('register adds an entry', () => {
    runner.register('extA', {
      name: 'daily',
      intervalMs: 60_000,
      handler: async () => {},
    });
    expect(runner.count()).toBe(1);
    expect(runner.count('extA')).toBe(1);
  });

  it('register skips a schedule with no timing (warning logged)', () => {
    runner.register('extA', {
      name: 'bad',
      handler: async () => {},
    });
    expect(runner.count()).toBe(0);
  });

  it('register skips a schedule with a cron expression (not yet supported)', () => {
    runner.register('extA', {
      name: 'cron-fail',
      cron: '0 3 * * *',
      handler: async () => {},
    });
    expect(runner.count()).toBe(0);
  });

  it('unregisterAll removes only that extension’s schedules', () => {
    runner.register('extA', { name: 's1', intervalMs: 1000, handler: async () => {} });
    runner.register('extA', { name: 's2', intervalMs: 2000, handler: async () => {} });
    runner.register('extB', { name: 's3', intervalMs: 3000, handler: async () => {} });
    expect(runner.count()).toBe(3);
    expect(runner.unregisterAll('extA')).toBe(2);
    expect(runner.count()).toBe(1);
    expect(runner.list()[0].ownerExt).toBe('extB');
  });

  it('list returns ext, name, and nextRunAt', () => {
    runner.register('extA', { name: 's1', intervalMs: 60_000, handler: async () => {} });
    const list = runner.list();
    expect(list).toHaveLength(1);
    expect(list[0].ownerExt).toBe('extA');
    expect(list[0].name).toBe('s1');
    expect(typeof list[0].nextRunAt).toBe('number');
  });

  it('clear wipes everything (test helper)', () => {
    runner.register('extA', { name: 's1', intervalMs: 1000, handler: async () => {} });
    runner.clear();
    expect(runner.count()).toBe(0);
  });
});

describe('CronRunnerImpl — execution via _runOne', () => {
  // We test _runOne directly with a stubbed db/ctx so we don't need a live
  // Postgres. _insertRun/_finishRun swallow errors when the db throws, which
  // is the behavior we rely on here.

  function makeRunner(): CronRunnerImpl {
    const r = new CronRunnerImpl();
    // Inject stubs by accessing private fields via "any" — testing-only.
    (r as any).db = {
      // Both insertInto and updateTable get called inside _insertRun / _finishRun.
      // We return objects whose chained calls eventually .execute() to nothing.
      insertInto: () => ({ values: () => ({ execute: async () => {} }) }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: async () => {} }) }),
      }),
    };
    (r as any).ctx = {};
    return r;
  }

  it('runs the handler exactly once when it succeeds', async () => {
    const runner = makeRunner();
    let calls = 0;
    const entry: any = {
      ownerExt: 'ext',
      schedule: {
        name: 's',
        intervalMs: 10_000,
        handler: async () => { calls++; },
      },
      nextRunAt: 0,
      inFlight: true,
    };
    await (runner as any)._runOne(entry);
    expect(calls).toBe(1);
  });

  it('retries up to maxAttempts when the handler throws', async () => {
    const runner = makeRunner();
    let calls = 0;
    const entry: any = {
      ownerExt: 'ext',
      schedule: {
        name: 's',
        intervalMs: 10_000,
        handler: async () => { calls++; throw new Error('boom'); },
        retry: { maxAttempts: 3, backoffMs: 1 },
      },
      nextRunAt: 0,
      inFlight: true,
    };
    await (runner as any)._runOne(entry);
    expect(calls).toBe(3);
  });

  it('stops retrying as soon as the handler succeeds', async () => {
    const runner = makeRunner();
    let calls = 0;
    const entry: any = {
      ownerExt: 'ext',
      schedule: {
        name: 's',
        intervalMs: 10_000,
        handler: async () => {
          calls++;
          if (calls < 2) throw new Error('first attempt fails');
        },
        retry: { maxAttempts: 5, backoffMs: 1 },
      },
      nextRunAt: 0,
      inFlight: true,
    };
    await (runner as any)._runOne(entry);
    expect(calls).toBe(2);
  });
});
