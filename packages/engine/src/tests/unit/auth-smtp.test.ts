/**
 * SMTP transport + sendEmail path (lib/auth.ts) — mocked nodemailer.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { _internalForTests } from '../../lib/auth.js';

const sendMailMock = mock(async () => ({ messageId: 'msg-1' }));
let createTransportCalls = 0;
let lastOptions: { secure?: boolean } = {};
let closeCalls = 0;

mock.module('nodemailer', () => ({
  createTransport: (options: { secure?: boolean }) => {
    createTransportCalls++;
    lastOptions = options;
    return {
      sendMail: sendMailMock,
      close: () => {
        closeCalls++;
      },
    };
  },
}));

let savedSmtp: Record<string, string | undefined> = {};

beforeEach(() => {
  savedSmtp = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT,
    SMTP_SECURE: process.env.SMTP_SECURE,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
  };
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_PORT = '587';
  process.env.SMTP_USER = 'mailer@example.com';
  process.env.SMTP_PASS = 'secret';
  process.env.SMTP_FROM = 'noreply@example.com';
  _internalForTests.resetSmtpCacheForTests();
  sendMailMock.mockClear();
  createTransportCalls = 0;
  closeCalls = 0;
  delete process.env.SMTP_SECURE;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedSmtp)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _internalForTests.resetSmtpCacheForTests();
});

describe('auth SMTP sendEmail', () => {
  it('sends mail through the cached nodemailer transport', async () => {
    await _internalForTests.sendEmailForTests(
      'user@example.com',
      'Verify account',
      '<p>Click here</p>',
      'Click here',
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Verify account',
        from: 'noreply@example.com',
      }),
    );
    expect(createTransportCalls).toBe(1);

    await _internalForTests.sendEmailForTests('user@example.com', 'Again', '<p>x</p>', 'x');
    expect(createTransportCalls).toBe(1);
  });

  it('recreates the transport when SMTP env fingerprint changes', async () => {
    await _internalForTests.sendEmailForTests('a@b.com', 'one', '<p>1</p>', '1');
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SECURE = 'true';
    await _internalForTests.sendEmailForTests('a@b.com', 'two', '<p>2</p>', '2');
    expect(createTransportCalls).toBe(2);
    // The replaced pool is closed, not left holding its connections.
    expect(closeCalls).toBe(1);
  });

  it('recreates the transport when only SMTP_PASS changes', async () => {
    await _internalForTests.sendEmailForTests('a@b.com', 'one', '<p>1</p>', '1');
    process.env.SMTP_PASS = 'rotated';
    await _internalForTests.sendEmailForTests('a@b.com', 'two', '<p>2</p>', '2');
    expect(createTransportCalls).toBe(2);
  });

  it('an unset SMTP_SECURE follows the port: 465 is implicit TLS, 587 is not', async () => {
    await _internalForTests.sendEmailForTests('a@b.com', 'one', '<p>1</p>', '1');
    expect(lastOptions.secure).toBe(false);
    process.env.SMTP_PORT = '465';
    await _internalForTests.sendEmailForTests('a@b.com', 'two', '<p>2</p>', '2');
    expect(lastOptions.secure).toBe(true);
    process.env.SMTP_SECURE = 'false';
    await _internalForTests.sendEmailForTests('a@b.com', 'three', '<p>3</p>', '3');
    expect(lastOptions.secure).toBe(false);
  });

  it('uses SMTP_USER as from when SMTP_FROM is unset', async () => {
    delete process.env.SMTP_FROM;
    process.env.SMTP_USER = 'mailer@example.com';
    _internalForTests.resetSmtpCacheForTests();
    await _internalForTests.sendEmailForTests('u@x.com', 'Hi', '<p>x</p>', 'x');
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'mailer@example.com' }),
    );
  });

  it('falls back to no-reply when neither SMTP_FROM nor SMTP_USER is set', async () => {
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_USER;
    _internalForTests.resetSmtpCacheForTests();
    await _internalForTests.sendEmailForTests('u@x.com', 'Hi', '<p>x</p>', 'x');
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'no-reply@zveltio.com' }),
    );
  });
});
