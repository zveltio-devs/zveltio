/**
 * authenticate + validateApiKey paths (lib/data/auth.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { authenticate } from '../../lib/data/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
const { hashApiKey } = await import('../../lib/security/api-key-hash.js');

const RAW_KEY = 'zvk_unit_test_key_0123456789abcdef';

function mockContext(headers: Record<string, string>): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()],
      raw: { headers: new Headers(headers) },
    },
  } as unknown as Context;
}

describe('authenticate', () => {
  let hash: string;

  afterEach(() => {
    // no persistent mocks
  });

  it('returns session user when better-auth resolves a session', async () => {
    const auth = {
      api: {
        getSession: async () => ({ user: { id: 'u-1', name: 'Alice', role: 'member' } }),
      },
    };
    const db = new CannedDb().kysely as unknown as Database;
    const result = await authenticate(mockContext({}), auth, db);
    expect(result).toEqual({
      user: { id: 'u-1', name: 'Alice', role: 'member' },
      authType: 'session',
    });
  });

  it('resolves a valid X-API-Key into an api_key user with scopes', async () => {
    hash = await hashApiKey(RAW_KEY);
    const db = new CannedDb();
    db.when(/from "zv_api_keys"/i, [
      {
        id: 'key-uuid-1',
        name: 'unit key',
        key_hash: hash,
        key_prefix: RAW_KEY.substring(0, 12),
        scopes: [{ collection: 'articles', actions: ['read'] }],
        rate_limit: 1000,
        expires_at: null,
        last_used_at: null,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
      },
    ]);
    db.when(/update "zv_api_keys" set "last_used_at"/i, []);

    const auth = { api: { getSession: async () => null } };
    const result = await authenticate(
      mockContext({ 'X-API-Key': RAW_KEY }),
      auth,
      db.kysely as unknown as Database,
    );
    expect(result?.authType).toBe('api_key');
    expect(result?.user.id).toBe('apikey:key-uuid-1');
    expect(result?.user.role).toBe('api_key');
    expect(result?.user.scopes).toEqual([{ collection: 'articles', actions: ['read'] }]);
  });

  it('accepts Bearer zvk_ tokens from Authorization header', async () => {
    hash = await hashApiKey(RAW_KEY);
    const db = new CannedDb();
    db.when(/from "zv_api_keys"/i, [
      {
        id: 'key-uuid-2',
        name: 'bearer key',
        key_hash: hash,
        key_prefix: RAW_KEY.substring(0, 12),
        scopes: [],
        rate_limit: 1000,
        expires_at: null,
        last_used_at: null,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
      },
    ]);
    db.when(/update "zv_api_keys"/i, []);

    const auth = { api: { getSession: async () => null } };
    const result = await authenticate(
      mockContext({ Authorization: `Bearer ${RAW_KEY}` }),
      auth,
      db.kysely as unknown as Database,
    );
    expect(result?.authType).toBe('api_key');
  });

  it('returns null for unknown or expired keys', async () => {
    const db = new CannedDb();
    db.when(/from "zv_api_keys"/i, []);
    const auth = { api: { getSession: async () => null } };
    const missing = await authenticate(
      mockContext({ 'X-API-Key': 'zvk_totally_unknown_key_00000000' }),
      auth,
      db.kysely as unknown as Database,
    );
    expect(missing).toBeNull();

    hash = await hashApiKey(RAW_KEY);
    const expiredDb = new CannedDb();
    expiredDb.when(/from "zv_api_keys"/i, [
      {
        id: 'expired',
        name: 'old',
        key_hash: hash,
        key_prefix: RAW_KEY.substring(0, 12),
        scopes: [],
        rate_limit: 1000,
        expires_at: new Date('2020-01-01').toISOString(),
        last_used_at: null,
        is_active: true,
        created_by: null,
        created_at: new Date().toISOString(),
      },
    ]);
    const expired = await authenticate(
      mockContext({ 'X-API-Key': RAW_KEY }),
      auth,
      expiredDb.kysely as unknown as Database,
    );
    expect(expired).toBeNull();
  });
});
