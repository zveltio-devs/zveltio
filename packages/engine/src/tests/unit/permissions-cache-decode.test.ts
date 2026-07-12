/**
 * permissions.ts — HMAC decode catch branches for malformed cache payloads.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
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

describe('cache decode catch paths', () => {
  it('ignores god cache entries with non-hex HMAC bytes', async () => {
    _setCacheForTests(makeCache(new Map([['god:u-editor', '1:not-valid-hex']])) as never);
    const db = seedDb();
    await initPermissions(db.kysely as unknown as Database);
    expect(await isGodUser('u-editor')).toBe(false);
    expect(db.executed(/SELECT role FROM "user"/i)).toHaveLength(1);
  });

  it('ignores roles cache entries when JSON parsing fails after HMAC check', async () => {
    const domain = DEFAULT_TENANT_ID;
    const json = 'not-json';
    const hmac = createHmac('sha256', process.env.BETTER_AUTH_SECRET!)
      .update(`roles:u-editor:${json}`)
      .digest('hex');
    const raw = `${json}:${hmac}`;
    _setCacheForTests(makeCache(new Map([[`roles:${domain}:u-editor`, raw]])) as never);

    await runWithDomain(domain, async () => {
      expect(await getUserRoles('u-editor')).toEqual(['editor']);
    });
  });

  it('falls through permission cache decode when BETTER_AUTH_SECRET is unset', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `perm:${domain}:u-editor:contacts:read`;
    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    _setCacheForTests(makeCache(new Map([[cacheKey, '1:deadbeef']])) as never);
    try {
      await runWithDomain(domain, async () => {
        expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
      });
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });

  it('ignores permission cache entries with malformed HMAC hex', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `perm:${domain}:u-editor:contacts:delete`;
    _setCacheForTests(makeCache(new Map([[cacheKey, '0:not-valid-hex']])) as never);
    await runWithDomain(domain, async () => {
      expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
    });
  });
});
