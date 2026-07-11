/**
 * initAuth bootstrap (lib/auth.ts) — fail-closed secret check and singleton wiring.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { getAuth, initAuth } from '../../lib/auth.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { CannedDb } from './fixtures/canned-db.js';

let savedSecret: string | undefined;
let savedCors: string | undefined;
let savedNodeEnv: string | undefined;
let savedValkey: string | undefined;
let savedSmtp: string | undefined;
let savedGoogleId: string | undefined;
let savedGoogleSecret: string | undefined;
let savedGithubId: string | undefined;
let savedGithubSecret: string | undefined;
let savedMicrosoftId: string | undefined;
let savedMicrosoftSecret: string | undefined;
let savedDiscordId: string | undefined;
let savedDiscordSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.BETTER_AUTH_SECRET;
  savedCors = process.env.CORS_ORIGINS;
  savedNodeEnv = process.env.NODE_ENV;
  savedValkey = process.env.VALKEY_URL;
  savedSmtp = process.env.SMTP_HOST;
  savedGoogleId = process.env.GOOGLE_CLIENT_ID;
  savedGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
  savedGithubId = process.env.GITHUB_CLIENT_ID;
  savedGithubSecret = process.env.GITHUB_CLIENT_SECRET;
  savedMicrosoftId = process.env.MICROSOFT_CLIENT_ID;
  savedMicrosoftSecret = process.env.MICROSOFT_CLIENT_SECRET;
  savedDiscordId = process.env.DISCORD_CLIENT_ID;
  savedDiscordSecret = process.env.DISCORD_CLIENT_SECRET;
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters-xx';
  delete process.env.VALKEY_URL;
  delete process.env.CORS_ORIGINS;
  delete process.env.NODE_ENV;
  delete process.env.SMTP_HOST;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  delete process.env.DISCORD_CLIENT_ID;
  delete process.env.DISCORD_CLIENT_SECRET;
  _setCacheForTests(null);
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedSecret;
  if (savedCors === undefined) delete process.env.CORS_ORIGINS;
  else process.env.CORS_ORIGINS = savedCors;
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedNodeEnv;
  if (savedValkey === undefined) delete process.env.VALKEY_URL;
  else process.env.VALKEY_URL = savedValkey;
  if (savedSmtp === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = savedSmtp;
  if (savedGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = savedGoogleId;
  if (savedGoogleSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = savedGoogleSecret;
  if (savedGithubId === undefined) delete process.env.GITHUB_CLIENT_ID;
  else process.env.GITHUB_CLIENT_ID = savedGithubId;
  if (savedGithubSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = savedGithubSecret;
  if (savedMicrosoftId === undefined) delete process.env.MICROSOFT_CLIENT_ID;
  else process.env.MICROSOFT_CLIENT_ID = savedMicrosoftId;
  if (savedMicrosoftSecret === undefined) delete process.env.MICROSOFT_CLIENT_SECRET;
  else process.env.MICROSOFT_CLIENT_SECRET = savedMicrosoftSecret;
  if (savedDiscordId === undefined) delete process.env.DISCORD_CLIENT_ID;
  else process.env.DISCORD_CLIENT_ID = savedDiscordId;
  if (savedDiscordSecret === undefined) delete process.env.DISCORD_CLIENT_SECRET;
  else process.env.DISCORD_CLIENT_SECRET = savedDiscordSecret;
  _setCacheForTests(null);
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
        warnSpy.mock.calls.some((c) =>
          String(c[0]).includes('CORS_ORIGINS is not set in production'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('initializes with Valkey secondary storage when cache is injected', async () => {
    process.env.VALKEY_URL = 'redis://localhost:6379';
    _setCacheForTests({
      get: async () => null,
      setex: async () => 'OK',
      set: async () => 'OK',
      del: async () => 1,
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
    } as never);
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
    expect(getAuth().api).toBeDefined();
  });

  it('initializes when SMTP_HOST is configured (transport created lazily)', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    const transportMock = { sendMail: mock(async () => ({ messageId: 'test' })) };
    mock.module('nodemailer', () => ({
      createTransport: () => transportMock,
    }));
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
  });

  it('initializes with Google social provider when GOOGLE_CLIENT_ID is set', async () => {
    process.env.GOOGLE_CLIENT_ID = 'google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
    expect(getAuth().api).toBeDefined();
  });

  it('initializes with GitHub social provider when GITHUB_CLIENT_ID is set', async () => {
    process.env.GITHUB_CLIENT_ID = 'github-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'github-secret';
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
  });

  it('initializes with Microsoft social provider when MICROSOFT_CLIENT_ID is set', async () => {
    process.env.MICROSOFT_CLIENT_ID = 'ms-client-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
    expect(getAuth().api).toBeDefined();
  });

  it('initializes with Discord social provider when DISCORD_CLIENT_ID is set', async () => {
    process.env.DISCORD_CLIENT_ID = 'discord-client-id';
    process.env.DISCORD_CLIENT_SECRET = 'discord-secret';
    await expect(initAuth(new CannedDb().kysely as unknown as Database)).resolves.toBeDefined();
  });
});
