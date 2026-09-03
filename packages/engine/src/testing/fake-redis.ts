/**
 * An in-memory stand-in for the ioredis client, for suites that need the cache
 * to EXIST without needing a Valkey.
 *
 * It lives here, once, because it lived in three harness files and the copies
 * were incomplete in the same way: `get`, `setex`, `sadd`, `expire` and nothing
 * else. `_setCacheForTests` installs it into the GLOBAL cache singleton, so
 * every cache-backed middleware in the request chain met it — not just the query
 * cache the suites were about. `tenantQuota` calls `cache.set(k, v, 'EX', 300)`
 * and `cache.incr(k)`, got `undefined is not a function`, and was swallowed by
 * its own fail-open handler:
 *
 *     [tenant-quota] middleware error (fail-open): cache.set is not a function
 *
 * Fifteen times in one run. Nothing failed, because failing open is what that
 * middleware is supposed to do when the cache is broken — so a fake that is
 * merely incomplete reads exactly like a cache that is merely down, and the
 * quota was disabled for the whole file without any suite saying so.
 *
 * The methods below are therefore the ones the engine actually calls, not the
 * ones a particular suite happens to exercise. `set` takes ioredis's real
 * variadic form (`set(key, value, 'EX', seconds)`) because that is the arity the
 * caller uses, and a fake with a friendlier signature is a fake that agrees with
 * code the real client would reject.
 */

export class FakeRedis {
  readonly store = new Map<string, string>();
  readonly sets = new Map<string, Set<string>>();
  /** Keys given an expiry, and the TTL asked for — assertable, never enforced. */
  readonly ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  /** ioredis: `set(key, value)` or `set(key, value, 'EX', seconds)`. */
  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    this.store.set(key, value);
    if (mode?.toUpperCase() === 'EX' && typeof ttl === 'number') this.ttls.set(key, ttl);
    return 'OK';
  }

  async setex(key: string, ttl: number, value: string): Promise<'OK'> {
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }

  /** Counts from zero and returns the NEW value, like the real one. */
  async incr(key: string): Promise<number> {
    const next = Number.parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const k of keys) {
      if (this.store.delete(k)) removed++;
      this.sets.delete(k);
      this.ttls.delete(k);
    }
    return removed;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    for (const m of members) s.add(String(m));
    this.sets.set(key, s);
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async expire(key: string, ttl: number): Promise<number> {
    this.ttls.set(key, ttl);
    return 1;
  }
}
