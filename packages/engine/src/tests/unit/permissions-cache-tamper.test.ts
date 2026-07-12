/**
 * Permissions cache — tampered HMAC entries fall through to Casbin (permissions.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getUserRoles,
  initPermissions,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'editor', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
  { ptype: 'g', v0: 'u-editor', v1: 'editor', v2: '*', v3: null, v4: null, v5: null },
];

function makeCache(store = new Map<string, string>()) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    sadd: async () => 1,
    expire: async () => 1,
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

function seedDb(): CannedDb {
  const canned = new CannedDb();
  canned.when(/FROM zvd_permissions/i, POLICY_ROWS);
  canned.when(/SELECT role FROM "user" WHERE id = /i, [{ role: 'member' }]);
  return canned;
}

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  await initPermissions(seedDb().kysely as unknown as Database);
});

afterAll(async () => {
  _setCacheForTests(null);
  await initPermissions(seedDb().kysely as unknown as Database);
});

describe('tampered permission caches', () => {
  it('ignores a tampered permission-result cache and re-evaluates via Casbin', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `perm:${domain}:u-editor:contacts:read`;
    _setCacheForTests(makeCache(new Map([[cacheKey, '1:deadbeef']])) as never);

    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
  });

  it('ignores a tampered roles cache and reloads from Casbin', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `roles:${domain}:u-editor`;
    _setCacheForTests(makeCache(new Map([[cacheKey, '["admin"]:deadbeef']])) as never);

    await runWithDomain(domain, async () => {
      expect(await getUserRoles('u-editor')).toEqual(['editor']);
    });
  });
});
