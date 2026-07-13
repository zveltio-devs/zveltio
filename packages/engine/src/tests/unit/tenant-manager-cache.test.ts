/**
 * Tenant manager Valkey cache paths (lib/tenancy/tenant-manager.ts) — in-memory cache mock.
 *
 * Exercises HMAC-signed cache hits, DB fallback on tampered entries, populate-on-miss,
 * and invalidateTenantCache del keys.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  getTenantById,
  getTenantBySlug,
  getUserTenants,
  initTenantManager,
  invalidateTenantCache,
} from '../../lib/tenancy/index.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  plan: 'pro',
  status: 'active',
  max_records: 1000,
  max_storage_gb: 10,
  max_api_calls_day: 10000,
  max_users: 25,
  settings: {},
};

function encodeCache(key: string, data: object): string {
  const json = JSON.stringify(data);
  const secret = process.env.BETTER_AUTH_SECRET!;
  const hmac = createHmac('sha256', secret).update(`tenant:${key}:${json}`).digest('hex');
  return `${hmac}:${json}`;
}

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
  initTenantManager(db.kysely as unknown as Database);
  return db;
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
});

afterEach(() => {
  _setCacheForTests(null);
});

describe('tenant cache — slug/id/user lookups', () => {
  it('returns a valid HMAC cache hit without querying the DB', async () => {
    const store = new Map<string, string>();
    const key = 'tenant:slug:acme';
    store.set(key, encodeCache(key, TENANT));
    _setCacheForTests(makeCache(store) as never);

    const db = setup();
    const tenant = await getTenantBySlug('acme');
    expect(tenant?.slug).toBe('acme');
    expect(db.executed(/zv_tenants/)).toHaveLength(0);
  });

  it('ignores tampered cache entries and repopulates from the DB', async () => {
    const store = new Map<string, string>();
    store.set('tenant:slug:acme', `deadbeef:${JSON.stringify(TENANT)}`);
    _setCacheForTests(makeCache(store) as never);

    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, [TENANT]);

    const tenant = await getTenantBySlug('acme');
    expect(tenant?.slug).toBe('acme');
    expect(db.executed(/zv_tenants/)).toHaveLength(1);
    expect(store.get('tenant:slug:acme')).toContain(TENANT.id);
  });

  it('caches getTenantById and getUserTenants on DB miss', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const db = setup();
    db.when(/select \* from "zv_tenants" where "id" = /, [TENANT]);
    db.when(/from "zv_tenant_users" as "tu" inner join "zv_tenants" as "t"/, [
      { ...TENANT, role: 'admin' },
    ]);

    await getTenantById(TENANT.id);
    expect(store.has(`tenant:id:${TENANT.id}`)).toBe(true);

    await getUserTenants('user-1');
    expect(store.has('user:tenants:user-1')).toBe(true);
  });
});

describe('invalidateTenantCache', () => {
  it('deletes slug, id, and user-tenant keys when a cache backend exists', async () => {
    const store = new Map<string, string>([
      ['tenant:slug:acme', 'x'],
      ['tenant:id:id-1', 'y'],
      ['user:tenants:u-1', 'z'],
    ]);
    _setCacheForTests(makeCache(store) as never);

    await invalidateTenantCache('acme', 'id-1', 'u-1');
    expect(store.size).toBe(0);
  });

  it('throws when populating cache without BETTER_AUTH_SECRET', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const db = setup();
    db.when(/select \* from "zv_tenants" where "slug" = /, [TENANT]);

    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await expect(getTenantBySlug('acme')).rejects.toThrow(/BETTER_AUTH_SECRET/);
      expect(store.has('tenant:slug:acme')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });
});
