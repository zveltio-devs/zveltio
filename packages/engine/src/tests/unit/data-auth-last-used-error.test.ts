/**
 * validateApiKey — last_used_at fire-and-forget error path (lib/data/auth.ts).
 */

import { describe, expect, it, spyOn } from 'bun:test';
import type { Context } from 'hono';
import type { Database } from '../../db/index.js';
import { authenticate } from '../../lib/data/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
const { hashApiKey } = await import('../../lib/security/api-key-hash.js');

const RAW_KEY = 'zvk_last_used_fail_key_0123456789ab';

function mockContext(headers: Record<string, string>): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: {
      header: (name: string) => lower[name.toLowerCase()],
      raw: { headers: new Headers(headers) },
    },
  } as unknown as Context;
}

describe('validateApiKey last_used_at update failure', () => {
  it('still returns the api key user when last_used_at update rejects', async () => {
    const hash = await hashApiKey(RAW_KEY);
    const db = new CannedDb();
    db.when(/from "zv_api_keys"/i, [
      {
        id: 'key-uuid-err',
        name: 'err key',
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
    db.fail(/update "zv_api_keys" set "last_used_at"/i, new Error('write timeout'));

    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const auth = { api: { getSession: async () => null } };
      const result = await authenticate(
        mockContext({ 'X-API-Key': RAW_KEY }),
        auth,
        db.kysely as unknown as Database,
      );
      expect(result?.authType).toBe('api_key');
      expect(result?.user.id).toBe('apikey:key-uuid-err');
      await Bun.sleep(10);
      expect(
        errSpy.mock.calls.some((c) => String(c[0]).includes('last_used_at update failed')),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
