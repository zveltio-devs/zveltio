/**
 * Hot-reload coalescing (extension-loader.ts triggerReload).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { _internalForTests, setReloadCallback } from '../../lib/extensions/extension-loader.js';

afterEach(() => {
  _internalForTests.resetReloadState();
  setReloadCallback(async () => {});
});

describe('triggerReload coalescing', () => {
  it('is a no-op when no reload callback is registered', async () => {
    await expect(_internalForTests.triggerReload('noop')).resolves.toBeUndefined();
  });

  it('coalesces overlapping triggers into at most two rebuilds', async () => {
    let calls = 0;
    setReloadCallback(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
    });

    const p1 = _internalForTests.triggerReload('burst-1');
    const p2 = _internalForTests.triggerReload('burst-2');
    const p3 = _internalForTests.triggerReload('burst-3');
    await Promise.all([p1, p2, p3]);

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it('swallows callback errors without rejecting callers', async () => {
    setReloadCallback(async () => {
      throw new Error('rebuild exploded');
    });
    await expect(_internalForTests.triggerReload('fail-soft')).resolves.toBeUndefined();
  });
});
