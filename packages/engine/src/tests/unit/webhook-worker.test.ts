/**
 * Unit coverage for webhook-worker.ts — the queue consumer that drains
 * `webhook:queue`, delivers each payload via WebhookManager, schedules retries
 * with exponential backoff, and re-enqueues due retries.
 *
 * Driven with a fake Redis (injected via _setCacheForTests) + a stubbed
 * globalThis.fetch (WebhookManager.deliver → safeFetch → fetch). No Valkey, no
 * network.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type Redis from 'ioredis';
import { _setCacheForTests } from '../../lib/runtime/index.js';
import { WEBHOOK_DLQ_KEY, webhookWorker } from '../../lib/webhook-worker.js';

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for the worker under test
type Args = any[];

class FakeRedis {
  zaddCalls: Args[] = [];
  zremCalls: Args[] = [];
  rpushCalls: Args[] = [];
  lpushCalls: Args[] = [];
  ltrimCalls: Args[] = [];
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
  async lpush(...a: Args): Promise<number> {
    this.lpushCalls.push(a);
    return 1;
  }
  async ltrim(...a: Args): Promise<string> {
    this.ltrimCalls.push(a);
    return 'OK';
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

  it('dead-letters the payload instead of dropping it', async () => {
    // What used to happen here was nothing: the payload fell out of the loop
    // and was gone. A webhook is how the outside world learns something
    // happened, so a silent drop is a business event that quietly did not
    // occur — and the delivery metric counts a failure the same whether it
    // was retried or abandoned, so no dashboard showed it either.
    stubFetch(500);
    const cache = new FakeRedis({ lmpop: [payload({ attempt: 3, retryAttempts: 3 })] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();

    expect(cache.lpushCalls.length).toBe(1);
    expect(cache.lpushCalls[0][0]).toBe(WEBHOOK_DLQ_KEY);
    const dead = JSON.parse(cache.lpushCalls[0][1] as string);
    expect(dead.url).toBe('https://hooks.example.com/x');
    expect(dead.event).toBe('record.created');
    expect(dead.data).toEqual({ id: '1' }); // the body, so a replay can resend it
    expect(typeof dead.failedAt).toBe('string');
  });

  it('caps the dead-letter queue', async () => {
    // The failure this exists for — an endpoint down for a week — is the one
    // that produces the most entries, so it must not be able to fill the cache.
    stubFetch(500);
    const cache = new FakeRedis({ lmpop: [payload({ attempt: 3, retryAttempts: 3 })] });
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(cache.ltrimCalls[0]).toEqual([WEBHOOK_DLQ_KEY, 0, 999]);
  });

  it('keeps draining when the dead-letter write fails', async () => {
    // The cache being unreachable is itself a reason deliveries fail. Losing
    // the record is bad; stopping the worker is worse.
    stubFetch(500);
    const cache = new FakeRedis({ lmpop: [payload({ attempt: 3, retryAttempts: 3 })] });
    cache.lpush = async () => {
      throw new Error('cache gone');
    };
    _setCacheForTests(cache as unknown as Redis);
    expect(webhookWorker._process()).resolves.toBeUndefined();
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

  it('logs unexpected _process errors from the polling interval', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const origProcess = webhookWorker._process;
    webhookWorker._process = async () => {
      throw new Error('poll blew up');
    };
    try {
      _setCacheForTests({} as never);
      webhookWorker.start(5);
      await new Promise((r) => setTimeout(r, 20));
      webhookWorker.stop();
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('Unexpected error in _process')),
      ).toBe(true);
    } finally {
      webhookWorker._process = origProcess;
      errSpy.mockRestore();
      _setCacheForTests(null);
    }
  });
});
