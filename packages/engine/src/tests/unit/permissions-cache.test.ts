/**
 * Valkey-backed permission / role / god caches (lib/tenancy/permissions.ts).
 *
 * Exercises HMAC-signed cache hits, tamper fallback, and invalidation with a
 * fake Redis injected via _setCacheForTests. Casbin policies come from the same
 * canned seed as permissions-casbin.test.ts (initPermissions runs in beforeAll).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'crypto';
import type Redis from 'ioredis';
import type { Database } from '../../db/index.js';
import {
  checkPermission,
  getUserRoles,
  initPermissions,
  invalidateGodCache,
  invalidateUserPermCache,
  isGodUser,
} from '../../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/tenant-manager.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

// biome-ignore lint/suspicious/noExplicitAny: fake Redis for cache under test
type Args = any[];

class PermFakeRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  delCalls: Args[] = [];
  setexCalls: Args[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async setex(key: string, _ttl: number, val: string): Promise<'OK'> {
    this.setexCalls.push([key, _ttl, val]);
    this.store.set(key, val);
    return 'OK';
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
  async expire(_key: string, _ttl: number): Promise<number> {
    return 1;
  }
  async del(...keys: Args): Promise<number> {
    this.delCalls.push(keys);
    for (const k of keys) {
      this.store.delete(String(k));
      this.sets.delete(String(k));
    }
    return keys.length;
  }
}

const POLICY_ROWS = [
  { ptype: 'p', v0: 'editor', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
  { ptype: 'g', v0: 'u-editor', v1: 'editor', v2: '*', v3: null, v4: null, v5: null },
];

function seedDb(): CannedDb {
  const canned = new CannedDb();
  canned.when(/FROM zvd_permissions/i, POLICY_ROWS);
  canned.when(/SELECT role FROM "user" WHERE id = /i, (q) => [
    { role: q.parameters[0] === 'u-god' ? 'god' : 'member' },
  ]);
  return canned;
}

function signPerm(key: string, allowed: boolean): string {
  const value = allowed ? '1' : '0';
  const secret = process.env.BETTER_AUTH_SECRET!;
  const hmac = createHmac('sha256', secret).update(`perm:${key}:${value}`).digest('hex');
  return `${value}:${hmac}`;
}

function signGod(userId: string, isGod: boolean): string {
  const value = isGod ? '1' : '0';
  const secret = process.env.BETTER_AUTH_SECRET!;
  const hmac = createHmac('sha256', secret).update(`god:${userId}:${value}`).digest('hex');
  return `${value}:${hmac}`;
}

function signRoles(userId: string, roles: string[]): string {
  const json = JSON.stringify(roles);
  const secret = process.env.BETTER_AUTH_SECRET!;
  const hmac = createHmac('sha256', secret).update(`roles:${userId}:${json}`).digest('hex');
  return `${json}:${hmac}`;
}

let roleSelectCount = 0;
let db: CannedDb;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  db = seedDb();
  db.when(/SELECT role FROM "user" WHERE id = /i, (q) => {
    roleSelectCount++;
    return [{ role: q.parameters[0] === 'u-god' ? 'god' : 'member' }];
  });
  await initPermissions(db.kysely as unknown as Database);
});

afterAll(async () => {
  _setCacheForTests(null);
  await initPermissions(seedDb().kysely as unknown as Database);
});

afterEach(() => {
  _setCacheForTests(null);
  roleSelectCount = 0;
});

describe('isGodUser cache', () => {
  it('hits Valkey on the second lookup (one DB round-trip total)', async () => {
    const redis = new PermFakeRedis();
    _setCacheForTests(redis as unknown as Redis);

    expect(await isGodUser('u-editor')).toBe(false);
    expect(await isGodUser('u-editor')).toBe(false);
    expect(roleSelectCount).toBe(1);
    expect(redis.store.has('god:u-editor')).toBe(true);
  });

  it('ignores a tampered god cache entry and re-reads from DB', async () => {
    const redis = new PermFakeRedis();
    redis.store.set('god:u-god', '1:deadbeef');
    _setCacheForTests(redis as unknown as Redis);

    expect(await isGodUser('u-god')).toBe(true);
    expect(roleSelectCount).toBe(1);
  });
});

describe('checkPermission cache', () => {
  it('returns a signed cache hit without re-querying Casbin', async () => {
    const redis = new PermFakeRedis();
    const cacheKey = `perm:${DEFAULT_TENANT_ID}:u-editor:contacts:read`;
    redis.store.set(cacheKey, signPerm(cacheKey, true));
    _setCacheForTests(redis as unknown as Redis);

    expect(await checkPermission('u-editor', 'contacts', 'read')).toBe(true);
    const permWrites = redis.setexCalls.filter((c) => String(c[0]).startsWith('perm:'));
    expect(permWrites.length).toBe(0);
  });

  it('writes a signed denial to cache after a Casbin miss', async () => {
    const redis = new PermFakeRedis();
    _setCacheForTests(redis as unknown as Redis);

    expect(await checkPermission('u-editor', 'contacts', 'delete')).toBe(false);
    const cacheKey = `perm:${DEFAULT_TENANT_ID}:u-editor:contacts:delete`;
    expect(redis.store.get(cacheKey)).toMatch(/^0:[0-9a-f]{64}$/);
    expect(redis.sets.get(`user:perm-keys:u-editor`)?.has(cacheKey)).toBe(true);
  });
});

describe('getUserRoles cache', () => {
  it('serves roles from a valid HMAC cache entry', async () => {
    const redis = new PermFakeRedis();
    const cacheKey = `roles:${DEFAULT_TENANT_ID}:u-editor`;
    redis.store.set(cacheKey, signRoles('u-editor', ['editor']));
    _setCacheForTests(redis as unknown as Redis);

    expect(await getUserRoles('u-editor')).toEqual(['editor']);
  });
});

describe('cache invalidation', () => {
  it('invalidateGodCache deletes the god key', async () => {
    const redis = new PermFakeRedis();
    redis.store.set('god:u-god', signGod('u-god', true));
    _setCacheForTests(redis as unknown as Redis);

    await invalidateGodCache('u-god');
    expect(redis.store.has('god:u-god')).toBe(false);
  });

  it('invalidateUserPermCache deletes tracked perm/role keys', async () => {
    const redis = new PermFakeRedis();
    const permKey = `perm:${DEFAULT_TENANT_ID}:u-editor:contacts:read`;
    redis.store.set(permKey, signPerm(permKey, true));
    redis.sets.set('user:perm-keys:u-editor', new Set([permKey]));
    redis.store.set(`roles:${DEFAULT_TENANT_ID}:u-editor`, signRoles('u-editor', ['editor']));
    redis.store.set('god:u-editor', signGod('u-editor', false));
    _setCacheForTests(redis as unknown as Redis);

    await invalidateUserPermCache('u-editor');
    expect(redis.store.has(permKey)).toBe(false);
    expect(redis.delCalls.length).toBeGreaterThan(0);
  });
});
