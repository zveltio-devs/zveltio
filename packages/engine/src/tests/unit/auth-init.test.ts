/**
 * initAuth bootstrap (lib/auth.ts) — fail-closed secret check and singleton wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getAuth, initAuth } from '../../lib/auth.js';
import { CannedDb } from './fixtures/canned-db.js';

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters-xx';
  delete process.env.VALKEY_URL;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedSecret;
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
});
