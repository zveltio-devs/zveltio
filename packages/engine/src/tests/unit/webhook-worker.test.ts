/**
 * Unit coverage for webhook-worker.ts — the queue consumer that drains
 * `webhook:queue`, delivers each payload via WebhookManager, schedules retries
 * with exponential backoff, and re-enqueues due retries.
 *
 * Driven with a fake Redis (injected via _setCacheForTests) + a stubbed
 * globalThis.fetch (WebhookManager.deliver → safeFetch → fetch). No Valkey, no
 * network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import { _setCacheForTests } from '../../lib/runtime/index.js';
import { webhookWorker } from '../../lib/webhook-worker.js';

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for the worker under test
type Args = any[];

class FakeRedis {
  zaddCalls: Args[] = [];
  zremCalls: Args[] = [];
  rpushCalls: Args[] = [];
  lpopQueue: string[] = [];
  private lmpopItems: string[] | null;
  private lmpopThrows: boolean;
  private due: string[];

  constructor(opts: { lmpop?: string[] | null; lmpopThrows?: boolean; due?: string[] } = {}) {
    this.lmpopItems = opts.lmpop ?? null;
    this.lmpopThrows = opts.lmpopThrows ?? false;
    this.due = opts.due ?? [];
  }
  async lmpop(): Promise<[string, string[]] | null> {
    if (this.lmpopThrows) throw new Error('LMPOP unsupported');
    return this.lmpopItems ? ['webhook:queue', this.lmpopItems] : null;
  }
  async lpop(): Promise<string | null> {
    return this.lpopQueue.shift() ?? null;
  }
  async zadd(...a: Args): Promise<number> {
    this.zaddCalls.push(a);
    return 1;
  }
  async zrangebyscore(): Promise<string[]> {
    return this.due;
  }
  async zrem(...a: Args): Promise<number> {
    this.zremCalls.push(a);
    return 1;
  }
  async rpush(...a: Args): Promise<number> {
    this.rpushCalls.push(a);
    return 1;
  }
}

let originalFetch: typeof fetch;
let fetchUrls: string[];

function stubFetch(status = 200): void {
  fetchUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return { status, ok: status < 400, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: 'https://hooks.example.com/x',
    event: 'record.created',
    collection: 'c',
    data: { id: '1' },
    timestamp: 't',
    attempt: 0,
    retryAttempts: 3,
    ...over,
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  _setCacheForTests(null);
  webhookWorker.stop();
});

describe('webhookWorker._process', () => {
  it('is a no-op when no cache is configured', async () => {
    _setCacheForTests(null);
    await webhookWorker._process();
    expect(fetchUrls.length).toBe(0);
  });

  it('drains the queue via LMPOP and delivers each payload', async () => {
    const cache = new FakeRedis({ lmpop: [payload()] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(fetchUrls).toEqual(['https://hooks.example.com/x']);
    expect(cache.zaddCalls.length).toBe(0); // 2xx → no retry scheduled
  });

  it('discards a malformed queue item without delivering', async () => {
    const cache = new FakeRedis({ lmpop: ['not json{'] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(fetchUrls.length).toBe(0);
  });

  it('schedules a retry (zadd) when delivery fails and attempts remain', async () => {
    stubFetch(500); // deliver → false
    const cache = new FakeRedis({ lmpop: [payload({ attempt: 0, retryAttempts: 3 })] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(cache.zaddCalls.length).toBe(1);
    expect(cache.zaddCalls[0][0]).toBe('webhook:retry');
    // retry payload has an incremented attempt
    const retried = JSON.parse(cache.zaddCalls[0][2] as string);
    expect(retried.attempt).toBe(1);
  });

  it('does not retry once attempts are exhausted', async () => {
    stubFetch(500);
    const cache = new FakeRedis({ lmpop: [payload({ attempt: 3, retryAttempts: 3 })] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(cache.zaddCalls.length).toBe(0);
  });

  it('falls back to LPOP when LMPOP is unsupported', async () => {
    const cache = new FakeRedis({ lmpopThrows: true });
    cache.lpopQueue = [payload()];
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(fetchUrls).toEqual(['https://hooks.example.com/x']);
  });

  it('re-enqueues retries that are now due', async () => {
    const dueItem = payload({ attempt: 1 });
    const cache = new FakeRedis({ lmpop: null, due: [dueItem] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(cache.zremCalls[0]).toEqual(['webhook:retry', dueItem]);
    expect(cache.rpushCalls[0]).toEqual(['webhook:queue', dueItem]);
  });
});

describe('webhookWorker lifecycle', () => {
  it('start is idempotent and stop clears the timer', () => {
    _setCacheForTests(null); // interval ticks are no-ops
    webhookWorker.start(10_000);
    webhookWorker.start(10_000); // second call must be a no-op
    webhookWorker.stop();
    // stop is safe to call twice
    expect(() => webhookWorker.stop()).not.toThrow();
  });
});
