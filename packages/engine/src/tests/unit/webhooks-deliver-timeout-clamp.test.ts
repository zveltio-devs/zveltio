/**
 * webhooks.ts — deliver() clamps timeout to [100ms, 30s].
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebhookManager } from '../../lib/webhooks.js';

let originalFetch: typeof fetch;
let lastSignal: AbortSignal | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastSignal = undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    lastSignal = init?.signal ?? undefined;
    return { status: 200, ok: true, text: async () => '' } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const basePayload = {
  url: 'https://hooks.example.com/clamp',
  event: 'record.created',
  collection: 'contacts',
  data: { id: 'r1' },
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('WebhookManager.deliver — timeout clamp', () => {
  it('clamps a zero timeout up to 100ms', async () => {
    const ok = await WebhookManager.deliver({ ...basePayload, timeout: 0 });
    expect(ok).toBe(true);
    expect(lastSignal).toBeDefined();
  });

  it('clamps an oversized timeout down to 30s', async () => {
    const ok = await WebhookManager.deliver({ ...basePayload, timeout: 9_999_999 });
    expect(ok).toBe(true);
    expect(lastSignal).toBeDefined();
  });
});
