/**
 * extension-utils.ts — inMemoryMutex swallows a rejected prior lock (.catch).
 */

import { describe, expect, it } from 'bun:test';
import { inMemoryMutex } from '../../lib/extensions/extension-utils.js';

describe('inMemoryMutex — prior rejection', () => {
  it('serializes behind a failing prior call without propagating its error', async () => {
    const order: string[] = [];

    const failing = inMemoryMutex('mutex-prior-reject', async () => {
      order.push('first-start');
      await Bun.sleep(30);
      order.push('first-end');
      throw new Error('first blew up');
    });

    await Promise.resolve();

    const second = inMemoryMutex('mutex-prior-reject', async () => {
      order.push('second');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('first blew up');
    await expect(second).resolves.toBe('ok');
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
