import { describe, it, expect } from 'bun:test';
import { inMemoryMutex } from '../../lib/extensions/extension-loader.js';

// We test the in-memory mutex directly. The composed `withExtensionLock`
// adds a Postgres advisory lock on top, which is covered by integration
// tests against a real DB (extensions.integration.test.ts).

describe('inMemoryMutex', () => {
  it('serializes concurrent calls for the same key', async () => {
    const order: number[] = [];

    const p1 = inMemoryMutex('lock-test-same', async () => {
      order.push(1);
      await Bun.sleep(40);
      order.push(2);
    });

    // Yield once so the first call registers in the map before the second.
    await Promise.resolve();

    const p2 = inMemoryMutex('lock-test-same', async () => {
      order.push(3);
      await Bun.sleep(5);
      order.push(4);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('runs only one at a time when three callers queue behind each other', async () => {
    // Two callers cannot show it: the bug let every caller that arrived while
    // the first ran read the same prior and then run together.
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const job = (name: string) =>
      inMemoryMutex('lock-test-three', async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(name);
        await Bun.sleep(20);
        active--;
      });

    await Promise.all([job('a'), job('b'), job('c')]);
    expect(peak).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('allows concurrent calls for different keys', async () => {
    const log: string[] = [];

    const p1 = inMemoryMutex('lock-test-A', async () => {
      log.push('A-start');
      await Bun.sleep(30);
      log.push('A-end');
    });

    const p2 = inMemoryMutex('lock-test-B', async () => {
      log.push('B-start');
      await Bun.sleep(5);
      log.push('B-end');
    });

    await Promise.all([p1, p2]);

    // B must finish before A — proving they ran in parallel, not serially.
    expect(log.indexOf('B-end')).toBeLessThan(log.indexOf('A-end'));
  });

  it('releases the lock after a failure so subsequent calls proceed', async () => {
    const seen: string[] = [];

    await expect(
      inMemoryMutex('lock-test-fail', async () => {
        seen.push('first');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Second call must run — would hang or skip if the lock leaked.
    await inMemoryMutex('lock-test-fail', async () => {
      seen.push('second');
    });

    expect(seen).toEqual(['first', 'second']);
  });

  it('propagates the return value of fn', async () => {
    const result = await inMemoryMutex('lock-test-return', async () => {
      return { ok: true, count: 42 };
    });
    expect(result).toEqual({ ok: true, count: 42 });
  });
});
