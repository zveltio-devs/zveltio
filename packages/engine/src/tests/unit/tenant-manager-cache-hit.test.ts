/**
 * tenant-manager.ts — cache HIT paths for getTenantById / getUserTenants.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getTenantById, getUserTenants, initTenantManager } from '../../lib/tenancy/index.js';
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

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
});

afterEach(() => {
  _setCacheForTests(null);
});

describe('tenant cache — id and user-tenant hits', () => {
  it('getTenantById returns a valid cache hit without querying the DB', async () => {
    const store = new Map<string, string>();
    const key = `tenant:id:${TENANT.id}`;
    store.set(key, encodeCache(key, TENANT));
    _setCacheForTests(makeCache(store) as never);

    const db = new CannedDb();
    initTenantManager(db.kysely as unknown as Database);

    const tenant = await getTenantById(TENANT.id);
    expect(tenant?.id).toBe(TENANT.id);
    expect(db.executed(/zv_tenants/)).toHaveLength(0);
  });

  it('getUserTenants returns a valid cache hit without querying the DB', async () => {
    const store = new Map<string, string>();
    const key = 'user:tenants:user-1';
    const rows = [{ ...TENANT, role: 'admin' }];
    store.set(key, encodeCache(key, rows));
    _setCacheForTests(makeCache(store) as never);

    const db = new CannedDb();
    initTenantManager(db.kysely as unknown as Database);

    const tenants = await getUserTenants('user-1');
    expect(tenants).toHaveLength(1);
    expect(tenants[0]?.role).toBe('admin');
    expect(db.executed(/zv_tenant_users/)).toHaveLength(0);
  });
});
