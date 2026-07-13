/**
 * createCacheSecondaryStorage — corrupt JSON entries are treated as cache misses.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { _setCacheForTests, createCacheSecondaryStorage } from '../../lib/runtime/cache.js';

afterEach(() => {
  _setCacheForTests(null);
});

describe('createCacheSecondaryStorage — corrupt JSON', () => {
  it('returns null from get when the stored value is not valid JSON', async () => {
    const store = new Map<string, string>([['bad-key', 'not-json{{{']]);
    _setCacheForTests({
      get: async (key: string) => store.get(key) ?? null,
      setex: async () => 'OK',
      set: async () => 'OK',
      del: async () => 1,
      pipeline: () => ({
        get() {
          return this;
        },
        setex() {
          return this;
        },
        del() {
          return this;
        },
        exec: async () => [],
      }),
    } as never);

    const storage = await createCacheSecondaryStorage();
    expect(storage).not.toBeNull();
    expect(await storage!.get('bad-key')).toBeNull();
  });
});
