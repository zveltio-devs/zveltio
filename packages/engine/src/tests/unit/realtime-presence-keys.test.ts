/**
 * Presence keys carry a tenant.
 *
 * `presence:${channel}` was once global, so two tenants that both had a
 * `standup` channel shared one set. That was fixed by routing every use through
 * `presenceKey()` — and the metadata hash beside it, `presence_meta:...`, was
 * left as three raw template literals one line below. Same bug, same function,
 * missed because the fix went in without a test and nothing pinned the shape of
 * the keys these functions write.
 *
 * The assertion is deliberately "no key lacks the tenant" rather than a list of
 * expected key names. A test that names the keys it knows about would have
 * passed while `presence_meta` was unscoped, because nobody thought to name it.
 *
 * No `mock.module` here on purpose: mocking `getCache` globally replaces it for
 * every other file in the same `bun test` run — measured at 53 unrelated
 * failures — and these functions take the cache as an argument anyway.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import { _presenceInternals } from '../../routes/realtime.js';

/** Records every key touched, and answers reads like an empty store. */
function recordingCache() {
  const keys: string[] = [];
  const note = (k: string) => {
    keys.push(k);
  };
  return {
    keys,
    zadd: async (k: string) => note(k),
    zrem: async (k: string) => note(k),
    zremrangebyscore: async (k: string) => note(k),
    zrange: async (k: string) => {
      note(k);
      return [];
    },
    hset: async (k: string) => note(k),
    del: async (k: string) => note(k),
    pexpire: async (k: string) => note(k),
  };
}

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const META = { name: 'Ana', email: 'ana@example.com' };

let cache = recordingCache();
beforeEach(() => {
  cache = recordingCache();
});

describe('presence keys are tenant-scoped', () => {
  it('join writes no key that lacks the tenant', async () => {
    await _presenceInternals.join(cache, A, 'standup', 'user-1', META);

    expect(cache.keys.length).toBeGreaterThan(0);
    for (const k of cache.keys) {
      // The failure this pins: `presence_meta:standup:user-1` — channel and
      // user, no tenant, so two tenants with a `standup` channel collide.
      expect(k).toContain(A);
    }
  });

  it('leave touches no key that lacks the tenant', async () => {
    await _presenceInternals.leave(cache, A, 'standup', 'user-1');

    expect(cache.keys.length).toBeGreaterThan(0);
    for (const k of cache.keys) {
      expect(k).toContain(A);
    }
  });

  it('leave deletes exactly what join wrote', async () => {
    // A delete that misses is how a stale hash outlives the session that owns
    // it — and an unscoped delete in one tenant removes another tenant's.
    await _presenceInternals.join(cache, A, 'standup', 'user-1', META);
    const written = new Set(cache.keys);

    cache.keys.length = 0;
    await _presenceInternals.leave(cache, A, 'standup', 'user-1');

    for (const k of cache.keys) {
      expect(written.has(k)).toBe(true);
    }
  });

  it('two tenants on the same channel share no key at all', async () => {
    await _presenceInternals.join(cache, A, 'standup', 'user-1', META);
    const first = new Set(cache.keys);

    cache.keys.length = 0;
    await _presenceInternals.join(cache, B, 'standup', 'user-1', META);

    expect(cache.keys.length).toBeGreaterThan(0);
    for (const k of cache.keys) {
      expect(first.has(k)).toBe(false);
    }
  });

  it('a null tenant still namespaces, rather than falling back to a bare key', async () => {
    // Single-tenant deployments pass null. If that produced `presence_meta:...`
    // with no segment, a later multi-tenant install would collide with rows
    // written before the migration.
    await _presenceInternals.join(cache, null, 'standup', 'user-1', META);

    for (const k of cache.keys) {
      expect(k).toContain('default');
    }
  });
});
