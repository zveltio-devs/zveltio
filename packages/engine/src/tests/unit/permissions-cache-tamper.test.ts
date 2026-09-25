/**
 * Permissions cache — tampered HMAC entries fall through to Casbin (permissions.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  __cacheNamespace,
  checkPermission,
  getUserRoles,
  initPermissions,
  isGodUser,
  runWithDomain,
} from '../../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'editor', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
  { ptype: 'g', v0: 'u-editor', v1: 'editor', v2: '*', v3: null, v4: null, v5: null },
  { ptype: 'g', v0: 'u-a', v1: 'editor', v2: 'tenant-a', v3: null, v4: null, v5: null },
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
    const cacheKey = `perm:${__cacheNamespace()}:${domain}:u-editor:contacts:read`;
    _setCacheForTests(makeCache(new Map([[cacheKey, '1:deadbeef']])) as never);

    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
  });

  it('ignores a tampered roles cache and reloads from Casbin', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `roles:${__cacheNamespace()}:${domain}:u-editor`;
    _setCacheForTests(makeCache(new Map([[cacheKey, '["admin"]:deadbeef']])) as never);

    await runWithDomain(domain, async () => {
      expect(await getUserRoles('u-editor')).toEqual(['editor']);
    });
  });

  // The entries above fail on shape (a 4-byte signature, or no parseable JSON)
  // before the HMAC is compared. A forger writes the right shape: these carry a
  // 64-hex signature and a value Casbin would not grant, so only the signature
  // comparison stands between them and the answer.
  const FORGED_SIG = '0'.repeat(64);

  it('refuses a well-formed permission grant with a forged signature', async () => {
    const cacheKey = `perm:${__cacheNamespace()}:${DEFAULT_TENANT_ID}:u-editor:contacts:delete`;
    _setCacheForTests(makeCache(new Map([[cacheKey, `1:${FORGED_SIG}`]])) as never);

    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
  });

  it('refuses a well-formed roles list with a forged signature', async () => {
    const cacheKey = `roles:${__cacheNamespace()}:${DEFAULT_TENANT_ID}:u-editor`;
    _setCacheForTests(makeCache(new Map([[cacheKey, `["admin"]:${FORGED_SIG}`]])) as never);

    await runWithDomain(DEFAULT_TENANT_ID, async () => {
      expect(await getUserRoles('u-editor')).toEqual(['editor']);
    });
  });

  it('refuses a well-formed god flag with a forged signature', async () => {
    _setCacheForTests(makeCache(new Map([['god:u-forged', `1:${FORGED_SIG}`]])) as never);

    expect(await isGodUser('u-forged')).toBe(false);
  });

  // A genuine entry copied to another key. The signature is valid, so only its
  // binding to the key it was written under can refuse it.
  it('refuses a genuine permission answer replayed under another action', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const readKey = `perm:${__cacheNamespace()}:${DEFAULT_TENANT_ID}:u-editor:contacts:read`;
    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
    const granted = store.get(readKey);
    expect(granted).toBeString();

    store.set(`perm:${__cacheNamespace()}:${DEFAULT_TENANT_ID}:u-editor:contacts:delete`, granted!);
    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
  });

  it('keeps roles cached for one tenant out of another', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    await runWithDomain('tenant-a', async () => {
      expect(await getUserRoles('u-a')).toEqual(['editor']);
    });
    await runWithDomain('tenant-b', async () => {
      expect(await getUserRoles('u-a')).toEqual([]);
    });

    store.set(
      `roles:${__cacheNamespace()}:tenant-b:u-a`,
      store.get(`roles:${__cacheNamespace()}:tenant-a:u-a`)!,
    );
    await runWithDomain('tenant-b', async () => {
      expect(await getUserRoles('u-a')).toEqual([]);
    });
  });
});
