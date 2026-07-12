/**
 * initCache (lib/runtime/cache.ts) — lazy Valkey connect via mocked ioredis.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let connectCalls = 0;
let capturedOpts: Record<string, unknown> | null = null;

class FakeRedis {
  constructor(_url: string, opts: Record<string, unknown>) {
    capturedOpts = opts;
  }

  async connect() {
    connectCalls++;
  }
}

mock.module('ioredis', () => ({
  default: FakeRedis,
}));

const { _setCacheForTests, getCache, initCache } = await import('../../lib/runtime/cache.js');

beforeEach(() => {
  connectCalls = 0;
  capturedOpts = null;
  delete process.env.VALKEY_URL;
  _setCacheForTests(null);
});

afterEach(() => {
  _setCacheForTests(null);
  delete process.env.VALKEY_URL;
});

describe('initCache', () => {
  it('returns null when VALKEY_URL is unset', async () => {
    expect(await initCache()).toBeNull();
    expect(getCache()).toBeNull();
  });

  it('connects lazily and exposes the singleton', async () => {
    process.env.VALKEY_URL = 'redis://127.0.0.1:6379';
    const client = await initCache();
    expect(client).not.toBeNull();
    expect(connectCalls).toBe(1);
    expect(getCache()).toBe(client);
  });

  it('passes an exponential backoff retryStrategy to ioredis', async () => {
    process.env.VALKEY_URL = 'redis://127.0.0.1:6379';
    await initCache();
    const retry = capturedOpts?.retryStrategy as (times: number) => number;
    expect(typeof retry).toBe('function');
    expect(retry(1)).toBeGreaterThanOrEqual(100);
    expect(retry(10)).toBeLessThanOrEqual(1100);
  });
});
