/**
 * RLS policy cache (lib/tenancy/rls.ts) — loadPolicies Valkey hit/miss/invalidate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getRlsFilters, initRls, invalidateRlsCache } from '../../lib/tenancy/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY = {
  id: 'p1',
  collection: 'contacts',
  role: '*',
  filter_field: 'owner_id',
  filter_op: 'eq',
  filter_value_source: 'user_id',
  is_enabled: true,
  description: null,
};

function makeCache(store = new Map<string, string>()) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
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
  };
}

function setup(): CannedDb {
  const db = new CannedDb();
  initRls(db.kysely as unknown as Database);
  return db;
}

beforeEach(() => {
  _setCacheForTests(null);
});

afterEach(() => {
  _setCacheForTests(null);
});

describe('getRlsFilters with Valkey cache', () => {
  it('serves policies from cache without querying the DB', async () => {
    const store = new Map<string, string>([['rls:policies:contacts', JSON.stringify([POLICY])]]);
    _setCacheForTests(makeCache(store) as never);
    const db = setup();

    const filters = await getRlsFilters(
      'contacts',
      { id: 'u-1', email: 'u@x.com', role: 'editor' },
      'session',
    );
    expect(filters).toHaveLength(1);
    expect(db.executed(/FROM zvd_rls_policies/i)).toHaveLength(0);
  });

  it('populates cache on DB miss and invalidateRlsCache clears it', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [POLICY]);

    await getRlsFilters('contacts', { id: 'u-1', role: 'editor' }, 'session');
    expect(store.has('rls:policies:contacts')).toBe(true);

    await invalidateRlsCache('contacts');
    expect(store.has('rls:policies:contacts')).toBe(false);
  });

  it('falls through to DB when cached JSON is corrupt', async () => {
    const store = new Map<string, string>([['rls:policies:contacts', 'not-json']]);
    _setCacheForTests(makeCache(store) as never);
    const db = setup();
    db.when(/FROM zvd_rls_policies/i, [POLICY]);

    const filters = await getRlsFilters('contacts', { id: 'u-1', role: 'editor' }, 'session');
    expect(filters).toHaveLength(1);
    expect(db.executed(/FROM zvd_rls_policies/i)).toHaveLength(1);
  });
});
