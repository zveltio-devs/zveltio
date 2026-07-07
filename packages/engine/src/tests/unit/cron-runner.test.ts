import { describe, it, expect, beforeEach } from 'bun:test';
import { computeNextRun, CronRunnerImpl } from '../../lib/runtime/cron-runner.js';

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
        handler: async () => {
          calls++;
        },
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
        handler: async () => {
          calls++;
          throw new Error('boom');
        },
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

  // ── S2-05 closure: trace_id propagation ────────────────────────────────

  it('persists a trace_id on insertRun (UUID fallback when OTel is disabled)', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const r = new CronRunnerImpl();
    (r as any).db = {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => {
          inserts.push(row);
          return { execute: async () => {} };
        },
      }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: async () => {} }) }),
      }),
    };
    (r as any).ctx = {};
    const entry: any = {
      ownerExt: 'ext',
      schedule: { name: 's', intervalMs: 10_000, handler: async () => {} },
      nextRunAt: 0,
      inFlight: true,
    };
    await (r as any)._runOne(entry);
    expect(inserts).toHaveLength(1);
    const row = inserts[0];
    // When OTel exporter is not configured, getTracer() returns a no-op
    // tracer whose span trace_id is all-zeros. Our code substitutes the
    // run's UUID so the column is still useful for grep.
    expect(typeof row.trace_id).toBe('string');
    expect((row.trace_id as string).length).toBeGreaterThan(0);
    // No-op tracer trace_id is all-zeros; we should NOT have persisted that.
    expect(row.trace_id).not.toBe('00000000000000000000000000000000');
  });

  it('writes a fresh trace_id per retry attempt', async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const r = new CronRunnerImpl();
    (r as any).db = {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => {
          inserts.push(row);
          return { execute: async () => {} };
        },
      }),
      updateTable: () => ({
        set: () => ({ where: () => ({ execute: async () => {} }) }),
      }),
    };
    (r as any).ctx = {};
    const entry: any = {
      ownerExt: 'ext',
      schedule: {
        name: 's',
        intervalMs: 10_000,
        handler: async () => {
          throw new Error('always');
        },
        retry: { maxAttempts: 3, backoffMs: 1 },
      },
      nextRunAt: 0,
      inFlight: true,
    };
    await (r as any)._runOne(entry);
    expect(inserts).toHaveLength(3);
    const traceIds = new Set(inserts.map((row) => row.trace_id as string));
    expect(traceIds.size).toBe(3);
  });
});
