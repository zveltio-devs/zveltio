/**
 * Permissions Valkey cache paths (lib/tenancy/permissions.ts) — HMAC-signed god,
 * permission-result, and roles caches plus invalidateUserPermCache.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getUserRoles,
  initPermissions,
  invalidateGodCache,
  invalidateUserPermCache,
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

function secret(): string {
  return process.env.BETTER_AUTH_SECRET!;
}

function encodeGod(userId: string, isGod: boolean): string {
  const value = isGod ? '1' : '0';
  const hmac = createHmac('sha256', secret()).update(`god:${userId}:${value}`).digest('hex');
  return `${value}:${hmac}`;
}

function encodePerm(cacheKey: string, allowed: boolean): string {
  const value = allowed ? '1' : '0';
  const hmac = createHmac('sha256', secret()).update(`perm:${cacheKey}:${value}`).digest('hex');
  return `${value}:${hmac}`;
}

function encodeRoles(userId: string, roles: string[]): string {
  const json = JSON.stringify(roles);
  const hmac = createHmac('sha256', secret()).update(`roles:${userId}:${json}`).digest('hex');
  return `${json}:${hmac}`;
}

function makeCache(store = new Map<string, string>()) {
  const sets = new Map<string, Set<string>>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    sadd: async (setKey: string, member: string) => {
      if (!sets.has(setKey)) sets.set(setKey, new Set());
      sets.get(setKey)!.add(member);
      return 1;
    },
    smembers: async (setKey: string) => [...(sets.get(setKey) ?? [])],
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

describe('isGodUser cache', () => {
  it('returns a valid HMAC cache hit without querying the DB', async () => {
    const store = new Map<string, string>([['god:u-god', encodeGod('u-god', true)]]);
    _setCacheForTests(makeCache(store) as never);
    const db = seedDb();
    await initPermissions(db.kysely as unknown as Database);
    expect(await isGodUser('u-god')).toBe(true);
    expect(db.executed(/SELECT role FROM "user"/i)).toHaveLength(0);
  });

  it('ignores tampered god cache and repopulates from DB', async () => {
    const store = new Map<string, string>([['god:u-god', '1:deadbeef']]);
    _setCacheForTests(makeCache(store) as never);
    const db = seedDb();
    await initPermissions(db.kysely as unknown as Database);
    expect(await isGodUser('u-god')).toBe(true);
    expect(db.executed(/SELECT role FROM "user"/i)).toHaveLength(1);
  });

  it('invalidateGodCache deletes the god key', async () => {
    const store = new Map<string, string>([['god:u-editor', encodeGod('u-editor', false)]]);
    _setCacheForTests(makeCache(store) as never);
    await invalidateGodCache('u-editor');
    expect(store.has('god:u-editor')).toBe(false);
  });
});

describe('checkPermission cache', () => {
  it('returns a cached allow/deny without hitting Casbin', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `perm:${domain}:u-editor:contacts:read`;
    const store = new Map<string, string>([[cacheKey, encodePerm(cacheKey, true)]]);
    _setCacheForTests(makeCache(store) as never);

    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
  });

  it('populates the permission cache on Casbin evaluation', async () => {
    const store = new Map<string, string>();
    _setCacheForTests(makeCache(store) as never);
    const domain = DEFAULT_TENANT_ID;
    const denyKey = `perm:${domain}:u-editor:contacts:delete`;
    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
    expect(store.get(denyKey)?.startsWith('0:')).toBe(true);
  });
});

describe('getUserRoles cache', () => {
  it('returns HMAC-signed roles from cache', async () => {
    const domain = DEFAULT_TENANT_ID;
    const cacheKey = `roles:${domain}:u-editor`;
    const store = new Map<string, string>([[cacheKey, encodeRoles('u-editor', ['editor'])]]);
    _setCacheForTests(makeCache(store) as never);

    await runWithDomain(domain, async () => {
      expect(await getUserRoles('u-editor')).toEqual(['editor']);
    });
  });

  it('invalidateUserPermCache clears perm keys, roles, god, and tracking set', async () => {
    const domain = DEFAULT_TENANT_ID;
    const permKey = `perm:${domain}:u-editor:contacts:read`;
    const store = new Map<string, string>([
      [permKey, encodePerm(permKey, true)],
      [`roles:${domain}:u-editor`, encodeRoles('u-editor', ['editor'])],
      ['god:u-editor', encodeGod('u-editor', false)],
    ]);
    const cache = makeCache(store);
    await cache.sadd('user:perm-keys:u-editor', permKey);
    _setCacheForTests(cache as never);

    await invalidateUserPermCache('u-editor');
    expect(store.has('god:u-editor')).toBe(false);
    expect(store.has(permKey)).toBe(false);
  });
});
