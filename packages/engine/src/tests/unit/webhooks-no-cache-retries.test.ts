/**
 * The no-cache delivery path: retries and the record of an abandoned delivery.
 *
 * With a cache, `trigger` queues the payload and the worker owns retries and
 * the dead-letter queue. Without one, `trigger` used to call
 * `deliver(payload).catch(() => {})` exactly once — `retryAttempts` rides on the
 * payload and is read only by the worker, so a failed delivery was attempted
 * once and discarded with no record anywhere. A cache is not a documented
 * requirement for webhooks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { WebhookManager } from '../../lib/webhooks.js';

let originalFetch: typeof fetch;
let attempts: number[];

/** Fails `failFirst` times, then succeeds. Records each payload's `attempt`. */
function stubFetch(failFirst: number): void {
  attempts = [];
  let seen = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { data?: { n?: number } };
    attempts.push(body.data?.n ?? -1);
    const status = seen++ < failFirst ? 500 : 200;
    return { status, ok: status < 400, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

const base = {
  url: 'https://hooks.example.com/x',
  method: 'POST',
  event: 'record.created',
  collection: 'c',
  data: { n: 1 },
  timestamp: 't',
  attempt: 0,
};

/** No real waiting: the backoff is the worker's, 1s/2s/4s, and we only count it. */
const slept: number[] = [];
const noSleep = async (ms: number): Promise<void> => {
  slept.push(ms);
};

describe('WebhookManager._deliverWithRetries (no cache)', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    slept.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries a failed delivery instead of dropping it after one try', async () => {
    stubFetch(2); // two 500s, then a 200
    const ok = await WebhookManager._deliverWithRetries({ ...base, retryAttempts: 3 }, noSleep);
    expect(ok).toBe(true);
    expect(attempts.length).toBe(3);
  });

  it('honours retryAttempts and stops there', async () => {
    stubFetch(99); // never succeeds
    const ok = await WebhookManager._deliverWithRetries({ ...base, retryAttempts: 2 }, noSleep);
    expect(ok).toBe(false);
    expect(attempts.length).toBe(3); // the first try plus two retries
  });

  it('backs off the way the worker does', async () => {
    stubFetch(99);
    await WebhookManager._deliverWithRetries({ ...base, retryAttempts: 3 }, noSleep);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it('delivers once when retries are switched off', async () => {
    stubFetch(99);
    const ok = await WebhookManager._deliverWithRetries({ ...base, retryAttempts: 0 }, noSleep);
    expect(ok).toBe(false);
    expect(attempts.length).toBe(1);
    expect(slept).toEqual([]);
  });

  it('stops as soon as it succeeds', async () => {
    stubFetch(0);
    const ok = await WebhookManager._deliverWithRetries({ ...base, retryAttempts: 3 }, noSleep);
    expect(ok).toBe(true);
    expect(attempts.length).toBe(1);
    expect(slept).toEqual([]);
  });
});
