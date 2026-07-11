/**
 * initAuth bootstrap (lib/auth.ts) — fail-closed secret check and singleton wiring.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getAuth, initAuth } from '../../lib/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

let savedSecret: string | undefined;
let savedCors: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedSecret = process.env.BETTER_AUTH_SECRET;
  savedCors = process.env.CORS_ORIGINS;
  savedNodeEnv = process.env.NODE_ENV;
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters-xx';
  delete process.env.VALKEY_URL;
  delete process.env.CORS_ORIGINS;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedSecret;
  if (savedCors === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = savedCors;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
});

describe('initAuth', () => {
  it('throws when BETTER_AUTH_SECRET is missing', async () => {
    delete process.env.BETTER_AUTH_SECRET;
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).rejects.toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('initializes the auth singleton usable via getAuth()', async () => {
    await initAuth(new CannedDb().kysely as unknown as Database);
    const auth = getAuth();
    expect(auth.api).toBeDefined();
  });

  it('accepts an explicit CORS_ORIGINS allowlist', async () => {
    process.env.CORS_ORIGINS = 'https://studio.example.com, https://app.example.com';
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
  });

  it('warns in production when CORS_ORIGINS is unset', async () => {
    process.env.NODE_ENV = 'production';
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await initAuth(new CannedDb().kysely as unknown as Database);
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('CORS_ORIGINS is not set in production')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
