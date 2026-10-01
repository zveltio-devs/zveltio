/**
 * createCacheSecondaryStorage (lib/runtime/cache.ts) — JSON get/set/pipeline over fake Redis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { betterAuth } from 'better-auth';
import { _setCacheForTests, createCacheSecondaryStorage } from '../../lib/runtime/cache.js';

function makeCache(store = new Map<string, string>()) {
  const pipelineOps: Array<{ cmd: string; args: unknown[] }> = [];
  const expiries: Array<{ key: string; ttl: number }> = [];
  return {
    store,
    expiries,
    get: async (key: string) => store.get(key) ?? null,
    getdel: async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    },
    setex: async (key: string, ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    set: async (...args: unknown[]) => {
      const key = String(args[0]);
      const hasNx = args.includes('NX');
      if (hasNx && store.has(key)) return null;
      if (args.length >= 2) store.set(key, String(args[1]));
      return 'OK';
    },
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    incr: async (key: string) => {
      const n = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(n));
      return n;
    },
    expire: async (key: string, ttl: number) => {
      expiries.push({ key, ttl });
      return 1;
    },
    pipeline: () => {
      const chain = {
        get(key: string) {
          pipelineOps.push({ cmd: 'get', args: [key] });
          return chain;
        },
        setex(key: string, ttl: number, value: string) {
          pipelineOps.push({ cmd: 'setex', args: [key, ttl, value] });
          return chain;
        },
        del(key: string) {
          pipelineOps.push({ cmd: 'del', args: [key] });
          return chain;
        },
        async exec() {
          return pipelineOps.map((op) => {
            if (op.cmd === 'get') return [null, store.get(String(op.args[0])) ?? null];
            if (op.cmd === 'setex') {
              store.set(String(op.args[0]), String(op.args[2]));
              return [null, 'OK'];
            }
            if (op.cmd === 'del') {
              store.delete(String(op.args[0]));
              return [null, 1];
            }
            return [null, null];
          });
        },
      };
      return chain;
    },
  };
}

beforeEach(() => {
  delete process.env.VALKEY_URL;
});

afterEach(() => {
  _setCacheForTests(null);
});

describe('createCacheSecondaryStorage', () => {
  it('returns null when no cache is available', async () => {
    expect(await createCacheSecondaryStorage()).toBeNull();
  });

  it('get/set/delete round-trip JSON values', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(storage).not.toBeNull();

    await storage!.set('k1', { ok: true }, 60);
    expect(await storage!.get('k1')).toEqual({ ok: true });
    await storage!.delete('k1');
    expect(await storage!.get('k1')).toBeNull();
  });

  it('treats corrupted JSON as a cache miss', async () => {
    const fake = makeCache(new Map([['bad', 'not-json']]));
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(await storage!.get('bad')).toBeNull();
  });

  it('setnx writes only when the key is absent', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    await storage!.set('nx-key', { first: true });
    await storage!.setnx('nx-key', { second: true });
    expect(await storage!.get('nx-key')).toEqual({ first: true });
    await storage!.delete('nx-key');
    await storage!.setnx('nx-key', { fresh: true });
    expect(await storage!.get('nx-key')).toEqual({ fresh: true });
  });

  it('runs pipeline get/set/del operations', async () => {
    const fake = makeCache();
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    const results = await storage!.pipeline([
      { type: 'set', key: 'a', value: { n: 1 }, ttl: 30 },
      { type: 'get', key: 'a' },
      { type: 'del', key: 'a' },
    ]);
    expect(results[0]).toBe('OK');
    expect(results[1]).toBe('{"n":1}');
    expect(await storage!.get('a')).toBeNull();
  });

  it('returns an empty array when pipeline exec yields null', async () => {
    const fake = makeCache();
    fake.pipeline = () => ({
      get() {
        return this;
      },
      setex() {
        return this;
      },
      del() {
        return this;
      },
      exec: async () => null as never,
    });
    _setCacheForTests(fake as never);
    const storage = await createCacheSecondaryStorage();
    expect(await storage!.pipeline([{ type: 'get', key: 'missing' }])).toEqual([]);
  });
});

/**
 * Better-Auth refuses to serve without this method, and the refusal is a 500 on
 * every `/api/auth/*` route — sign-in included.
 *
 *     BetterAuthError: Secondary-storage rate limiting requires
 *                      SecondaryStorage.increment.
 *
 * It needs two things true at once: a secondary storage (Valkey configured) and
 * rate limiting on (Better-Auth turns it on by default only when
 * NODE_ENV=production). #402 made Valkey required, so the first is now true of
 * every production install.
 *
 * The whole harness runs NODE_ENV=test, where the rate limiter never starts —
 * which is why nothing here caught it and a live probe in the extensions repo
 * did. These tests hold the method's shape without needing production mode.
 */
describe('increment — the method whose absence takes authentication down', () => {
  it('counts up from one', async () => {
    const cache = makeCache();
    _setCacheForTests(cache as never);
    const s = (await createCacheSecondaryStorage())!;
    expect(await s.increment('rl:key')).toBe(1);
    expect(await s.increment('rl:key')).toBe(2);
    expect(await s.increment('rl:key')).toBe(3);
  });

  it('sets the window only on the FIRST increment', async () => {
    // Refreshing the TTL on every hit would let a steady stream of requests
    // hold the window open forever — the limit would never reset, and never
    // trip either, because the count would keep sliding.
    const cache = makeCache();
    _setCacheForTests(cache as never);
    const s = (await createCacheSecondaryStorage())!;
    await s.increment('rl:key', 60);
    await s.increment('rl:key', 60);
    await s.increment('rl:key', 60);
    expect(cache.expiries).toEqual([{ key: 'rl:key', ttl: 60 }]);
  });

  it('counts different keys apart', async () => {
    const cache = makeCache();
    _setCacheForTests(cache as never);
    const s = (await createCacheSecondaryStorage())!;
    await s.increment('a');
    await s.increment('a');
    expect(await s.increment('b')).toBe(1);
  });
});

/**
 * Better-Auth (since 1.7) consumes every single-use value — password-reset
 * tokens, magic links, email/phone OTPs, two-factor OTPs, one-time tokens —
 * through `getAndDelete`, called unguarded. Without it each of those flows threw
 * "secondaryStorage.getAndDelete is not a function" on every install with
 * Valkey, which since #402 is every production install.
 */
describe('getAndDelete — how Better-Auth redeems a single-use token', () => {
  it('returns the value once, then null', async () => {
    _setCacheForTests(makeCache() as never);
    const s = (await createCacheSecondaryStorage())!;
    await s.set('tok', { user: 'u1' });
    expect(await s.getAndDelete('tok')).toEqual({ user: 'u1' });
    expect(await s.getAndDelete('tok')).toBeNull();
    expect(await s.get('tok')).toBeNull();
  });

  it('is one GETDEL, never a GET and a DEL two requests could interleave', async () => {
    const cache = makeCache();
    const calls: string[] = [];
    for (const cmd of ['get', 'getdel', 'del'] as const) {
      const real = cache[cmd] as (...a: string[]) => Promise<unknown>;
      cache[cmd] = ((...a: string[]) => {
        calls.push(cmd);
        return real(...a);
      }) as never;
    }
    _setCacheForTests(cache as never);
    const s = (await createCacheSecondaryStorage())!;
    await s.set('tok', 'v');
    await s.getAndDelete('tok');
    expect(calls).toEqual(['getdel']);
  });

  it("Better-Auth's own consumeVerificationValue redeems a token exactly once", async () => {
    _setCacheForTests(makeCache() as never);
    const secondaryStorage = (await createCacheSecondaryStorage())!;
    // Same verification options as lib/auth.ts.
    const auth = betterAuth({
      secret: 'x'.repeat(32),
      secondaryStorage,
      verification: { storeIdentifier: 'hashed' },
    });
    const { internalAdapter } = await auth.$context;
    await internalAdapter.createVerificationValue({
      identifier: 'reset-password:tok',
      value: 'u1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const first = await internalAdapter.consumeVerificationValue('reset-password:tok');
    expect(first?.value).toBe('u1');
    expect(await internalAdapter.consumeVerificationValue('reset-password:tok')).toBeNull();
  });
});
