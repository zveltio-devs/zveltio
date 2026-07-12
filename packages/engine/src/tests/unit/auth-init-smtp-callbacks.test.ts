/**
 * initAuth SMTP email callbacks (lib/auth.ts) — sendResetPassword,
 * sendVerificationEmail, and magicLink sendMagicLink paths.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const sendMailMock = mock(async () => ({ messageId: 'msg-test' }));

mock.module('nodemailer', () => ({
  createTransport: () => ({ sendMail: sendMailMock }),
}));

type BetterAuthOptions = {
  emailAndPassword?: {
    sendResetPassword?: (args: {
      user: { email: string; name?: string };
      url: string;
    }) => Promise<void>;
  };
  emailVerification?: {
    sendVerificationEmail?: (args: {
      user: { email: string; name?: string };
      url: string;
    }) => Promise<void>;
  };
  plugins?: Array<{
    id?: string;
    sendMagicLink?: (args: { email: string; url: string }) => Promise<void>;
  }>;
};

let capturedOpts: BetterAuthOptions | null = null;

mock.module('better-auth', () => ({
  betterAuth: (opts: BetterAuthOptions) => {
    capturedOpts = opts;
    return { api: { getSession: async () => null } };
  },
}));

mock.module('better-auth/plugins', () => ({
  twoFactor: () => ({ id: 'two-factor' }),
  magicLink: (opts: {
    sendMagicLink?: (args: { email: string; url: string }) => Promise<void>;
  }) => ({ id: 'magic-link', ...opts }),
}));

mock.module('@better-auth/passkey', () => ({
  passkey: () => ({ id: 'passkey' }),
}));

const { initAuth, _internalForTests } = await import('../../lib/auth.js');

let savedSecret: string | undefined;
let savedSmtp: Record<string, string | undefined>;

beforeEach(() => {
  savedSecret = process.env.BETTER_AUTH_SECRET;
  savedSmtp = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_FROM: process.env.SMTP_FROM,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  process.env.BETTER_AUTH_SECRET = 'unit-test-secret-minimum-32-characters-xx';
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_FROM = 'noreply@example.com';
  process.env.SMTP_USER = 'mailer@example.com';
  process.env.SMTP_PASS = 'secret';
  capturedOpts = null;
  sendMailMock.mockClear();
  _internalForTests.resetSmtpCacheForTests();
  _internalForTests.resetAuthModuleForTests();
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = savedSecret;
  for (const [key, value] of Object.entries(savedSmtp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _internalForTests.resetAuthModuleForTests();
});

describe('initAuth SMTP callbacks', () => {
  it('wires sendResetPassword to the SMTP transport', async () => {
    await initAuth(new CannedDb().kysely as unknown as Database);
    const cb = capturedOpts?.emailAndPassword?.sendResetPassword;
    expect(cb).toBeDefined();
    await cb!({
      user: { email: 'user@example.com', name: 'Ada' },
      url: 'https://app/reset?token=abc',
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Reset your password',
        from: 'noreply@example.com',
      }),
    );
  });

  it('wires sendVerificationEmail to the SMTP transport', async () => {
    await initAuth(new CannedDb().kysely as unknown as Database);
    const cb = capturedOpts?.emailVerification?.sendVerificationEmail;
    expect(cb).toBeDefined();
    await cb!({
      user: { email: 'verify@example.com', name: 'Bob' },
      url: 'https://app/verify?token=xyz',
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'verify@example.com',
        subject: 'Verify your email',
      }),
    );
  });

  it('wires magicLink sendMagicLink to the SMTP transport', async () => {
    await initAuth(new CannedDb().kysely as unknown as Database);
    const magic = capturedOpts?.plugins?.find((p) => typeof p.sendMagicLink === 'function');
    expect(magic?.sendMagicLink).toBeDefined();
    await magic!.sendMagicLink!({
      email: 'magic@example.com',
      url: 'https://app/magic?token=m1',
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'magic@example.com',
        subject: 'Your sign-in link',
      }),
    );
  });
});
