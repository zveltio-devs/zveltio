/**
 * The engine's own outbound email — one SMTP transport, configured by the
 * SMTP_* environment variables, shared by auth mails (magic link, password
 * reset, verification), user invitations and the flow `send_email` step.
 */

// Cached transporter — nodemailer's `createTransport` opens a pool when
// `pool: true` is passed, so we want a single shared instance across
// every sender instead of reconnecting per send. The transporter is
// recreated whenever the SMTP env vars change shape (e.g. test harness
// flips them between runs); in normal production they're static after
// process start.
let _smtpTransport: import('nodemailer').Transporter | null = null;
let _smtpFingerprint = '';

function smtpFingerprint(): string {
  return [
    process.env.SMTP_HOST ?? '',
    process.env.SMTP_PORT ?? '',
    process.env.SMTP_SECURE ?? '',
    process.env.SMTP_USER ?? '',
  ].join('|');
}

async function getSmtpTransport(): Promise<import('nodemailer').Transporter> {
  const fp = smtpFingerprint();
  if (_smtpTransport && fp === _smtpFingerprint) return _smtpTransport;
  const { createTransport } = await import('nodemailer');
  _smtpTransport = createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
    pool: true,
    maxConnections: 3,
  });
  _smtpFingerprint = fp;
  return _smtpTransport;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

/** Sends one message. Throws when SMTP is not configured or delivery fails. */
export async function sendEmail(msg: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
}): Promise<void> {
  if (!isEmailConfigured()) throw new Error('Email is not configured: SMTP_HOST is not set');
  const transport = await getSmtpTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@zveltio.com',
    ...msg,
  });
}

/** Test-only export — never import outside src/tests/. */
export const _internalForTests = {
  resetSmtpCacheForTests() {
    _smtpTransport = null;
    _smtpFingerprint = '';
  },
};
