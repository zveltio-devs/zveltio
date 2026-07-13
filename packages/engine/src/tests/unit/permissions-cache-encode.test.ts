/**
 * permissions.ts — HMAC encode failures when BETTER_AUTH_SECRET is unset during cache writes.
 */

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
  canned.when(/SELECT role FROM "user" WHERE id = /i, (q) => [
    { role: q.parameters[0] === 'u-god' ? 'god' : 'member' },
  ]);
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

describe('cache encode without BETTER_AUTH_SECRET', () => {
  it('still resolves god status when the post-DB cache write cannot sign', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const db = seedDb();
    await initPermissions(db.kysely as unknown as Database);

    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(await isGodUser('u-god')).toBe(true);
      expect(store.has('god:u-god')).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });

  it('still evaluates permissions when the post-Casbin cache write cannot sign', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `perm:${domain}:u-editor:contacts:read`;

    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await runWithDomain(domain, async () => {
        expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
      });
      expect(store.has(cacheKey)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });

  it('still loads roles when the post-DB cache write cannot sign', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `roles:${domain}:u-editor`;

    const saved = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await runWithDomain(domain, async () => {
        expect(await getUserRoles('u-editor')).toEqual(['editor']);
      });
      expect(store.has(cacheKey)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = saved;
    }
  });
});
