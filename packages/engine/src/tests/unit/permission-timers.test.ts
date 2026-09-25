/**
 * The two timers in `lib/tenancy/permissions.ts`, on fake time.
 *
 * - The realtime re-check sweep retries after a lookup fails. It used to retry
 *   every 5 s for as long as the outage lasted; consecutive failures now back
 *   off (5 s, 10 s, 20 s … capped at 60 s) and a clean sweep resets that.
 * - The periodic policy reconcile fires every 30-60 s and re-arms after each
 *   tick until stopped. It had no test below the harness.
 *
 * No `mock.module` (it leaks across files here): the sweep is driven through a
 * real SSE registry entry whose re-check throws, and counts its runs.
 */
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import {
  revalidateSockets,
  startPolicyReconcile,
  stopPolicyReconcile,
} from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';

/** Let the async work a timer started run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('realtime re-check sweep retry', () => {
  const USER = `sweep-backoff-${Date.now()}`;
  let runs = 0;

  beforeEach(async () => {
    // Warm the dynamic imports on real time so a fake-time sweep only awaits
    // microtasks.
    revalidateSockets();
    await Bun.sleep(50);
    runs = 0;
    const sub = {
      stream: { abort() {} },
      // The re-check reads this first; throwing is a lookup that failed.
      get collections(): string[] {
        runs++;
        throw new Error('lookup down');
      },
      channels: [],
      filters: [],
      tenantId: null,
    };
    _sseConnectionsForTests().set(USER, new Set([sub]) as never);
    spyOn(console, 'error').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(async () => {
    _sseConnectionsForTests().delete(USER);
    // Fire the pending retry while time is still fake (switching back drops
    // it), so it sweeps clean and resets the backoff for the next test.
    jest.advanceTimersByTime(60_000);
    await flush();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Advance to just before `ms`, prove nothing ran, then cross it. */
  async function expectRetryAfter(ms: number) {
    const before = runs;
    jest.advanceTimersByTime(ms - 1);
    await flush();
    expect(runs).toBe(before);
    jest.advanceTimersByTime(1);
    await flush();
    expect(runs).toBe(before + 1);
  }

  it('backs off 5 s, 10 s, 20 s, 40 s, then holds at 60 s while lookups keep failing', async () => {
    revalidateSockets();
    await flush();
    expect(runs).toBe(1);
    await expectRetryAfter(5_000);
    await expectRetryAfter(10_000);
    await expectRetryAfter(20_000);
    await expectRetryAfter(40_000);
    await expectRetryAfter(60_000);
    await expectRetryAfter(60_000);
  });

  it('a sweep with no failures resets the wait to 5 s', async () => {
    revalidateSockets();
    await flush();
    await expectRetryAfter(5_000);
    await expectRetryAfter(10_000);
    // Lookups recover: the pending retry sweeps clean.
    const subs = _sseConnectionsForTests().get(USER)!;
    _sseConnectionsForTests().delete(USER);
    jest.advanceTimersByTime(20_000);
    await flush();
    // Fail again: the first retry is 5 s away, not 40.
    _sseConnectionsForTests().set(USER, subs);
    revalidateSockets();
    await flush();
    await expectRetryAfter(5_000);
  });
});

describe('periodic policy reconcile timer', () => {
  let ticks = 0;
  const tick = async () => {
    ticks++;
  };

  beforeEach(() => {
    ticks = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopPolicyReconcile();
    jest.useRealTimers();
  });

  it('first tick lands in 30-60 s, then re-arms after every tick', async () => {
    startPolicyReconcile(tick);
    jest.advanceTimersByTime(29_999);
    await flush();
    expect(ticks).toBe(0);
    for (let n = 1; n <= 4; n++) {
      // Each delay is in [30 s, 60 s): one 60 s step crosses exactly one tick.
      jest.advanceTimersByTime(60_000 - (n === 1 ? 29_999 : 0));
      await flush();
      expect(ticks).toBe(n);
    }
  });

  it('start is idempotent and stop ends it', async () => {
    startPolicyReconcile(tick);
    startPolicyReconcile(tick);
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(ticks).toBe(1);
    stopPolicyReconcile();
    jest.advanceTimersByTime(600_000);
    await flush();
    expect(ticks).toBe(1);
  });
});
