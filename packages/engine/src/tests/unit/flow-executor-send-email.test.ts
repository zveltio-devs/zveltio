/**
 * send_email step (flow-executor.ts) — delivers through the engine's SMTP
 * transport.
 *
 * The step used to `await import('../email.js')`, a module that has never
 * existed. The import always threw, the catch reported "Email service not
 * configured", and the step — and the run — ended as a success. No flow ever
 * sent an email, with or without SMTP configured.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Database } from '../../db/index.js';
import { _internalForTests as emailInternals } from '../../lib/email.js';
import { _internalForTests } from '../../lib/flows/flow-executor.js';
import { CannedDb } from './fixtures/canned-db.js';

const { executeStep } = _internalForTests;

const sendMailMock = mock(async (_msg: Record<string, unknown>) => ({ messageId: 'msg-1' }));

mock.module('nodemailer', () => ({
  createTransport: () => ({ sendMail: sendMailMock }),
}));

let savedHost: string | undefined;

beforeEach(() => {
  savedHost = process.env.SMTP_HOST;
  process.env.SMTP_HOST = 'smtp.example.com';
  emailInternals.resetSmtpCacheForTests();
  sendMailMock.mockClear();
  sendMailMock.mockImplementation(async () => ({ messageId: 'msg-1' }));
});

afterEach(() => {
  if (savedHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = savedHost;
  emailInternals.resetSmtpCacheForTests();
});

const run = (config: Record<string, unknown>) =>
  executeStep(new CannedDb().kysely as unknown as Database, { type: 'send_email', config }, {}, {});

describe('executeStep — send_email', () => {
  it('sends through SMTP, with newlines stripped from the subject', async () => {
    const { output } = await run({
      to: 'user@example.com',
      subject: 'Hello\r\nBcc: evil@bad.com',
      body: 'text',
    });

    expect(output).toEqual({ sent: true, to: 'user@example.com' });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const msg = sendMailMock.mock.calls[0][0];
    expect(msg.to).toBe('user@example.com');
    expect(msg.subject).toBe('Hello  Bcc: evil@bad.com');
    expect(msg.text).toBe('text');
  });

  it('fails the step when SMTP is not configured', async () => {
    delete process.env.SMTP_HOST;
    await expect(run({ to: 'user@example.com', subject: 'x', body: 'y' })).rejects.toThrow(
      /SMTP_HOST/,
    );
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('fails the step with the transport error when delivery fails', async () => {
    sendMailMock.mockImplementation(async () => {
      throw new Error('550 mailbox unavailable');
    });
    await expect(run({ to: 'user@example.com', subject: 'x', body: 'y' })).rejects.toThrow(
      /550 mailbox unavailable/,
    );
  });
});
