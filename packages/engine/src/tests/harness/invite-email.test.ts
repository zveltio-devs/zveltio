/**
 * `POST /api/users/invite` — the invitation email is actually sent.
 *
 * The route used to `await import('../lib/email.js')`, a module that has never
 * existed. With SMTP configured the import threw, an empty catch swallowed it,
 * and the admin was told "Invitation sent" — no invitation email ever left.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { _internalForTests as emailInternals } from '../../lib/email.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const sendMailMock = mock(async (_msg: Record<string, unknown>) => ({ messageId: 'msg-1' }));

mock.module('nodemailer', () => ({
  createTransport: () => ({ sendMail: sendMailMock }),
}));

let savedHost: string | undefined;

beforeEach(() => {
  savedHost = process.env.SMTP_HOST;
  emailInternals.resetSmtpCacheForTests();
  sendMailMock.mockClear();
  sendMailMock.mockImplementation(async () => ({ messageId: 'msg-1' }));
});

afterEach(() => {
  if (savedHost === undefined) delete process.env.SMTP_HOST;
  else process.env.SMTP_HOST = savedHost;
  emailInternals.resetSmtpCacheForTests();
});

async function invite() {
  const { app, db } = await getTestApp();
  const cookie = await createGodSession(app, db);
  const email = `inv-mail-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const res = await app.request('/api/users/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ email, name: 'Invitee', role: 'member' }),
  });
  expect(res.status).toBe(201);
  return { email, body: (await res.json()) as { email_sent: boolean; invite_url: string } };
}

d('POST /api/users/invite — invitation email', () => {
  it('sends the email when SMTP is configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    const { email, body } = await invite();

    expect(body.email_sent).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const msg = sendMailMock.mock.calls[0][0];
    expect(msg.to).toBe(email);
    expect(String(msg.html)).toContain(body.invite_url);
  });

  it('reports email_sent:false when delivery fails, and still returns the invite url', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    sendMailMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });
    const { body } = await invite();

    expect(body.email_sent).toBe(false);
    expect(body.invite_url).toContain('/accept-invite?token=');
  });

  it('does not try to send without SMTP', async () => {
    delete process.env.SMTP_HOST;
    const { body } = await invite();

    expect(body.email_sent).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
