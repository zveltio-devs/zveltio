/**
 * initAuth trusted-origins + cookie posture (lib/auth.ts).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

import * as realOs from 'node:os';

type BetterAuthOptions = {
  trustedOrigins?: string[];
  advanced?: {
    defaultCookieAttributes?: {
      secure?: boolean;
      sameSite?: string;
    };
  };
};

let capturedOpts: BetterAuthOptions | null = null;

const mockedNetworkInterfaces = () => ({
  eth0: [{ family: 'IPv4', internal: false, address: '10.0.0.42' }],
  lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
});

mock.module('os', () => ({
  ...realOs,
  networkInterfaces: mockedNetworkInterfaces,
  default: { ...realOs, networkInterfaces: mockedNetworkInterfaces },
}));

mock.module('better-auth', () => ({
  betterAuth: (opts: BetterAuthOptions) => {
    capturedOpts = opts;
    return { api: { getSession: async () => null } };
  },
}));

mock.module('better-auth/plugins', () => ({
  twoFactor: () => ({}),
  magicLink: () => ({}),
}));

mock.module('@better-auth/passkey', () => ({
  passkey: () => ({}),
}));

const { initAuth, _internalForTests } = await import('../../lib/auth.js');

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    PORT: process.env.PORT,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
    NODE_ENV: process.env.NODE_ENV,
    CROSS_DOMAIN_AUTH: process.env.CROSS_DOMAIN_AUTH,
  };
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters-xx';
  process.env.PORT = '4000';
  delete process.env.CORS_ORIGINS;
  delete process.env.NODE_ENV;
  delete process.env.CROSS_DOMAIN_AUTH;
  capturedOpts = null;
  _internalForTests.resetAuthModuleForTests();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _internalForTests.resetAuthModuleForTests();
});

describe('initAuth trusted origins', () => {
  it('auto-detects LAN IPv4 interfaces when CORS_ORIGINS is unset', async () => {
    await initAuth(new CannedDb().kysely as unknown as Database);
    const origins = capturedOpts?.trustedOrigins ?? [];
    expect(origins.some((o) => o.includes('10.0.0.42:4000'))).toBe(true);
    expect(origins.some((o) => o.includes('localhost:4000'))).toBe(true);
  });

  it('uses CROSS_DOMAIN_AUTH for secure + SameSite=None cookies', async () => {
    process.env.CROSS_DOMAIN_AUTH = 'true';
    await initAuth(new CannedDb().kysely as unknown as Database);
    const attrs = capturedOpts?.advanced?.defaultCookieAttributes;
    expect(attrs?.secure).toBe(true);
    expect(attrs?.sameSite).toBe('none');
  });
});
