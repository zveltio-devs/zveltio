/**
 * TypedEventBus pre-hook metadata (lib/runtime/event-bus.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { engineEvents } from '../../lib/runtime/event-bus.js';

afterEach(() => {
  engineEvents.clearPreHooks();
});

describe('engineEvents pre-hook helpers', () => {
  it('preHookCount tracks onBefore subscriptions and clearPreHooks resets all', async () => {
    expect(engineEvents.preHookCount('record.beforeInsert')).toBe(0);
    const unsub = engineEvents.onBefore('record.beforeInsert', () => {});
    expect(engineEvents.preHookCount('record.beforeInsert')).toBe(1);
    unsub();
    expect(engineEvents.preHookCount('record.beforeInsert')).toBe(0);

    engineEvents.onBefore('record.beforeUpdate', () => {});
    engineEvents.onBefore('record.beforeDelete', () => {});
    expect(engineEvents.preHookCount('record.beforeUpdate')).toBe(1);
    engineEvents.clearPreHooks();
    expect(engineEvents.preHookCount('record.beforeUpdate')).toBe(0);
    expect(engineEvents.preHookCount('record.beforeDelete')).toBe(0);
  });

  it('runs pre-hooks one after another, so each sees what the previous one changed', async () => {
    const seen: unknown[] = [];
    const offA = engineEvents.onBefore('record.beforeInsert', async (p) => {
      await new Promise((r) => setTimeout(r, 5));
      p.mutate({ stamped: true });
    });
    const offB = engineEvents.onBefore('record.beforeInsert', (p) => {
      seen.push(p.data.stamped);
    });
    try {
      await engineEvents.runBefore('record.beforeInsert', {
        collection: 'c',
        data: { a: 1 },
        userId: 'u',
      });
      expect(seen).toEqual([true]);
    } finally {
      offA();
      offB();
    }
  });
});
