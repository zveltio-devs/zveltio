/**
 * webhooks.ts — deliver() clamps timeout to [100ms, 30s].
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebhookManager } from '../../lib/webhooks.js';

let originalFetch: typeof fetch;
let originalTimeout: typeof AbortSignal.timeout;
let asked: number[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalTimeout = AbortSignal.timeout;
  asked = [];
  // The value handed to the signal is the clamp's output; a signal merely
  // existing says nothing about it.
  AbortSignal.timeout = (ms: number) => {
    asked.push(ms);
    return originalTimeout.call(AbortSignal, ms);
  };
  globalThis.fetch = (async () =>
    ({ status: 200, ok: true, text: async () => '' }) as Response) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

const basePayload = {
  url: 'https://hooks.example.com/clamp',
  event: 'record.created',
  collection: 'contacts',
  data: { id: 'r1' },
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('WebhookManager.deliver — timeout clamp', () => {
  it.each([
    [undefined, 5_000], // unset: the default
    [0, 5_000], // zero reads as unset, not as "no wait"
    [-1, 100],
    [50, 100],
    [2_500, 2_500],
    [9_999_999, 30_000],
  ])('timeout %p waits %p ms', async (timeout, expected) => {
    const ok = await WebhookManager.deliver({ ...basePayload, timeout });
    expect(ok).toBe(true);
    expect(asked).toEqual([expected]);
  });
});
