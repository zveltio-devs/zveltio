/**
 * webhook-worker.ts — LMPOP drains multiple queue items in one round-trip.
 */

/**
 * The delivery target is `.invalid` (RFC 6761: a name guaranteed never to
 * resolve), and that is load-bearing rather than cosmetic.
 *
 * `safeFetch` pins a resolved hostname to its ADDRESS: it requests the IP and
 * carries the name in a `Host` header. So the moment the test hostname
 * resolves, `fetch` is called with `https://<ip>/…` and headers as a `Headers`
 * object instead of the plain record it was handed — and every assertion below
 * that compares a URL or indexes a header fails. `hooks.example.com` does not
 * resolve on a developer machine and DOES resolve on the CI runner, so these
 * tests passed locally and went red in CI on branches that changed nothing
 * near them. Pinning itself is covered by `pinnedRequestForTests`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type Redis from 'ioredis';
import { _setCacheForTests } from '../../lib/runtime/index.js';
import { webhookWorker } from '../../lib/webhook-worker.js';

class FakeRedis {
  lpopQueue: string[] = [];
  private lmpopItems: string[] | null;

  constructor(items: string[] | null) {
    this.lmpopItems = items;
  }
  async lmpop(): Promise<[string, string[]] | null> {
    return this.lmpopItems ? ['webhook:queue', this.lmpopItems] : null;
  }
  async lpop(): Promise<string | null> {
    return this.lpopQueue.shift() ?? null;
  }
  async zadd(): Promise<number> {
    return 1;
  }
  async zrangebyscore(): Promise<string[]> {
    return [];
  }
  async zrem(): Promise<number> {
    return 1;
  }
  async rpush(): Promise<number> {
    return 1;
  }
}

function payload(url: string): string {
  return JSON.stringify({
    url,
    event: 'record.created',
    collection: 'c',
    data: { id: '1' },
    timestamp: 't',
    attempt: 0,
    retryAttempts: 3,
  });
}

let originalFetch: typeof fetch;
let fetchUrls: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return { status: 200, ok: true, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setCacheForTests(null);
  webhookWorker.stop();
});

describe('webhookWorker._process — LMPOP batch', () => {
  it('delivers every payload returned by a single LMPOP call', async () => {
    const cache = new FakeRedis([
      payload('https://one.invalid/h'),
      payload('https://two.invalid/h'),
    ]);
    _setCacheForTests(cache as unknown as Redis);
    await webhookWorker._process();
    expect(fetchUrls.sort()).toEqual(['https://one.invalid/h', 'https://two.invalid/h']);
  });
});
