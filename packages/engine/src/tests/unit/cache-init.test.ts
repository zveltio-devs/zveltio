/**
 * initCache (lib/runtime/cache.ts) — lazy Valkey connect via mocked ioredis.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let connectCalls = 0;
let capturedOpts: Record<string, unknown> | null = null;

/**
 * When set, `connect()` rejects the way ioredis really does: the useful reason
 * arrives on the 'error' event, and the rejection itself is generic.
 */
let failWith: string | null = null;

class FakeRedis {
  private handlers: ((err: Error) => void)[] = [];

  constructor(_url: string, opts: Record<string, unknown>) {
    capturedOpts = opts;
  }

  on(event: string, handler: (err: Error) => void) {
    if (event === 'error') this.handlers.push(handler);
    return this;
  }

  async connect() {
    connectCalls++;
    if (failWith) {
      for (const h of this.handlers) h(new Error(failWith));
      throw new Error('Connection is closed.');
    }
  }
}

mock.module('ioredis', () => ({
  default: FakeRedis,
}));

const { _setCacheForTests, getCache, initCache } = await import('../../lib/runtime/cache.js');

beforeEach(() => {
  connectCalls = 0;
  capturedOpts = null;
  failWith = null;
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

/**
 * A misconfigured Valkey used to stop the boot with an ioredis stack trace.
 *
 * ioredis puts the reason on the 'error' event and rejects `connect()` with
 * "Connection is closed." — so the line naming the fault was several lines above
 * the line that killed the engine, and looked unrelated to it. Now that Valkey
 * is required, this is the likeliest way to get the configuration wrong.
 */
describe('a Valkey that is configured but unreachable says why', () => {
  const boot = async (url: string, reason: string): Promise<string> => {
    process.env.VALKEY_URL = url;
    failWith = reason;
    try {
      await initCache();
      throw new Error('expected initCache to throw');
    } catch (err) {
      return (err as Error).message;
    }
  };

  it('names Valkey, the address, and the reason — not "Connection is closed."', async () => {
    const msg = await boot('redis://localhost:6379', 'NOAUTH Authentication required.');
    expect(msg).toContain('Valkey');
    expect(msg).toContain('redis://localhost:6379');
    expect(msg).toContain('NOAUTH Authentication required');
    expect(msg).not.toContain('Connection is closed');
  });

  it('does not double the full stop when the reason already ends in one', async () => {
    const msg = await boot('redis://localhost:6379', 'NOAUTH Authentication required.');
    expect(msg).not.toContain('..');
  });

  it('suggests the password for NOAUTH', async () => {
    const msg = await boot('redis://localhost:6379', 'NOAUTH Authentication required.');
    expect(msg).toContain('PASSWORD@host:port');
  });

  it('suggests checking the port for ECONNREFUSED', async () => {
    const msg = await boot('redis://localhost:6555', 'connect ECONNREFUSED 127.0.0.1:6555');
    expect(msg).toContain('Nothing is listening there');
  });

  it('NEVER prints the password from the URL', async () => {
    // The whole point of printing the address is that it is where the mistake
    // usually is; it is also the one place a secret can sit.
    const msg = await boot('redis://user:hunter2@localhost:6555', 'connect ECONNREFUSED');
    expect(msg).not.toContain('hunter2');
    expect(msg).not.toContain('user');
    expect(msg).toContain('localhost:6555');
  });

  it('echoes an unparseable URL back, because that is the fault itself', async () => {
    const msg = await boot('localhost-6379', 'connect ECONNREFUSED');
    expect(msg).toContain('localhost-6379');
  });

  it('says how to boot without a cache deliberately', async () => {
    const msg = await boot('redis://localhost:6555', 'connect ECONNREFUSED');
    expect(msg).toContain('ZVELTIO_ALLOW_NO_CACHE=1');
  });
});
