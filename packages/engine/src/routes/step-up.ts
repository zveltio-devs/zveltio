/**
 * Step-up endpoints and the gates on changing a sign-in factor.
 *
 * Mounted before the Better Auth catch-all, so these run first on its paths.
 *
 * A factor is what step-up trusts, so changing one is guarded like what it
 * guards. Better Auth asks only for a session — a fresh one — to register a
 * passkey or delete one; a stolen cookie could add the thief's authenticator and
 * then pass every step-up. So:
 * - the FIRST factor needs the password (TOTP enable already demands it; the
 *   passkey path is gated here), since there is nothing stronger to ask for. An
 *   account with no password (OAuth only) instead needs a session that an OAuth
 *   sign-in created at most five minutes ago: the provider just checked the person;
 * - once one exists, adding a passkey or TOTP, deleting a passkey, disabling
 *   TOTP, reading its secret back or regenerating backup codes needs a step-up
 *   token earned with an existing factor.
 * Each change is audited and, where SMTP is configured, mailed to the account.
 */
import type { Context, Hono, Next } from 'hono';
import type { Database } from '../db/index.js';
import { auth } from '../lib/auth.js';
import { auditLog } from '../lib/audit.js';
import { clientIpForAudit } from '../lib/security/index.js';
import {
  firstFactorRule,
  hasStepUpFactor,
  mailFactorChange,
  requireStepUp,
  stepUpOptions,
  stepUpVerify,
  totpActive,
} from '../lib/step-up.js';
import { type RequestSession, requestSession } from '../middleware/session-prefetch.js';

type FactorChange =
  | 'passkey.add'
  | 'passkey.remove'
  | 'totp.add'
  | 'totp.disable'
  | 'totp.reveal'
  | 'backup-codes.regenerate';

const DESCRIBE: Partial<Record<FactorChange, string>> = {
  'passkey.add': 'A passkey was added to your account.',
  'passkey.remove': 'A passkey was removed from your account.',
  'totp.add': 'An authenticator app was enabled on your account.',
  'totp.disable': 'The authenticator app was disabled on your account.',
};

function recordFactorChange(
  c: Context,
  poolDb: Database,
  user: RequestSession['user'],
  change: FactorChange,
  confirmedBy: string,
): void {
  auditLog(poolDb, {
    type: 'auth.factor_changed',
    userId: user.id,
    resourceType: 'auth_factor',
    resourceId: user.id,
    metadata: { change, confirmed_by: confirmedBy },
    ip: clientIpForAudit(c) ?? undefined,
    tenantId: null,
  }).catch((err: Error) => console.error('[step-up] factor-change audit failed:', err.message));
  mailFactorChange(user.email, DESCRIBE[change] ?? change);
}

async function passwordMatches(c: Context): Promise<boolean> {
  let password: unknown;
  try {
    password = ((await c.req.raw.clone().json()) as { password?: unknown }).password;
  } catch {
    return false;
  }
  if (typeof password !== 'string' || !password) return false;
  try {
    await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password } });
    return true;
  } catch {
    return false;
  }
}

/**
 * What confirms `change`, or the refusal: a step-up from an existing factor; for
 * the first one, the password — or, on an account that has none, a fresh OAuth sign-in.
 */
async function confirmChange(
  c: Context,
  session: RequestSession,
  change: FactorChange,
): Promise<string | Response> {
  const userId = session.user.id;
  if (await hasStepUpFactor(userId)) return requireStepUp(c, `factor.${change}`);
  const rule = await firstFactorRule(userId, session.session.token);
  if (rule === 'password') {
    // Better Auth checks it on its two-factor routes; its passkey route asks for none.
    if (change !== 'passkey.add' || (await passwordMatches(c))) return 'password';
    return c.json(
      { error: 'Enter your password to add your first sign-in factor', code: 'password_required' },
      403,
    );
  }
  if (rule === 'recent_sign_in') return 'oauth';
  return c.json(
    {
      error:
        'Sign in again with your sign-in provider, then add your first sign-in factor within five minutes.',
      code: 'recent_sign_in_required',
    },
    403,
  );
}

export function registerStepUpRoutes(app: Hono, poolDb: Database): void {
  app.post('/api/auth/step-up/options', stepUpOptions);
  app.post('/api/auth/step-up/verify', stepUpVerify);

  const gate = (change: FactorChange) => async (c: Context, next: Next) => {
    const session = await requestSession(c, auth);
    if (!session) return next(); // Better Auth refuses it in its own words.
    const confirmedBy = await confirmChange(c, session, change);
    if (confirmedBy instanceof Response) return confirmedBy;
    await next();
    // A TOTP secret is live only once verify-totp confirms it; that is audited there.
    if (c.res.status < 400 && change !== 'totp.add' && DESCRIBE[change]) {
      recordFactorChange(c, poolDb, session.user, change, confirmedBy);
    }
  };
  app.post('/api/auth/passkey/verify-registration', gate('passkey.add'));
  app.post('/api/auth/passkey/delete-passkey', gate('passkey.remove'));
  app.post('/api/auth/two-factor/enable', gate('totp.add'));
  app.post('/api/auth/two-factor/disable', gate('totp.disable'));
  // With `allowPasswordless`, Better Auth asks an account with no password for nothing here.
  app.post('/api/auth/two-factor/get-totp-uri', gate('totp.reveal'));
  app.post('/api/auth/two-factor/generate-backup-codes', gate('backup-codes.regenerate'));

  app.post('/api/auth/two-factor/verify-totp', async (c, next) => {
    const session = await requestSession(c, auth);
    // Without a session this is the sign-in challenge, not an enrollment.
    const enrolling = !!session && !(await totpActive(session.user.id));
    // With a session and TOTP already on, Better Auth only answers right or
    // wrong: an uncounted oracle for the code step-up would then accept.
    if (session && !enrolling) {
      return c.json({ error: 'TOTP is already enabled', code: 'totp_already_enabled' }, 400);
    }
    await next();
    if (session && enrolling && c.res.status < 400 && (await totpActive(session.user.id))) {
      recordFactorChange(c, poolDb, session.user, 'totp.add', 'totp');
    }
  });
}
