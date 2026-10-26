/**
 * God step-up (RFC extension model v3, "Installing and trusting code", item 3).
 *
 * A session alone does not install code. A mutation that does asks for a token
 * minted by a fresh passkey assertion (with user verification) or a TOTP code
 * from an enrolled authenticator app — bound to that session and to one named action, good for two
 * minutes and for one use. There is no password fallback: a password is what a
 * stolen session's owner is most likely to have lost along with it.
 *
 * Challenges, tokens and spent TOTP codes are rows in Better Auth's
 * `verification` table, on its own pool (`authPool`): a credential table that no
 * request or extension role can read (tenant-manager's credential list,
 * ext-db-role's NEVER_GRANTED). Each row's id is a SHA-256 over the secret, the
 * session id and the action, so a lookup with any of the three different finds
 * nothing, and the stored value never yields a usable secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { sql } from 'kysely';
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { auth, authPool, passkeyRelyingParty } from './auth.js';
import { type RequestSession, requestSession } from '../middleware/session-prefetch.js';
import { refuseWithoutSession } from './admin-guard.js';
import { isEmailConfigured, sendEmail } from './email.js';

export type StepUpMethod = 'passkey' | 'totp';

/** The twoFactor plugin's endpoint; the module's `auth` type does not carry plugin endpoints. */
interface TotpApi {
  verifyTOTP(args: { headers: Headers; body: { code: string } }): Promise<unknown>;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** How the request's step-up token was earned, for the god audit row. */
    stepUpMethod?: StepUpMethod;
  }
}

export const STEP_UP_HEADER = 'X-Zveltio-Step-Up';
const TTL_SECONDS = 120;
/** `extension.install:crm`, `extension.config:storage/x`, `factor.passkey.add`. */
const ACTION_RE = /^[a-z][a-z0-9._-]*(:[a-z0-9._@/-]+)?$/i;

export const isStepUpAction = (a: unknown): a is string =>
  typeof a === 'string' && a.length <= 200 && ACTION_RE.test(a);

const rowId = (kind: string, ...parts: string[]) =>
  `step-up-${kind}:${createHash('sha256').update(parts.join('\n')).digest('base64url')}`;

interface PasskeyRow {
  id: string;
  credentialID: string;
  publicKey: string;
  counter: number;
  transports: string | null;
}

/** The factors that can step up: passkeys, and TOTP once its enrollment is verified. */
async function factorsOf(userId: string): Promise<{ passkeys: PasskeyRow[]; totp: boolean }> {
  const db = authPool();
  const passkeys = await sql<PasskeyRow>`
    SELECT id, "credentialID", "publicKey", counter, transports
      FROM passkey WHERE "userId" = ${userId}`.execute(db);
  const totp = await sql<{ enabled: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM "user" u JOIN "twoFactor" t ON t."userId" = u.id
       WHERE u.id = ${userId} AND u."twoFactorEnabled" AND t.verified
    ) AS enabled`.execute(db);
  return { passkeys: passkeys.rows, totp: totp.rows[0]?.enabled === true };
}

export async function hasStepUpFactor(userId: string): Promise<boolean> {
  const { passkeys, totp } = await factorsOf(userId);
  return passkeys.length > 0 || totp;
}

export async function totpActive(userId: string): Promise<boolean> {
  return (await factorsOf(userId)).totp;
}

export async function hasPassword(userId: string): Promise<boolean> {
  const r = await sql<{ yes: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM account
       WHERE "userId" = ${userId} AND "providerId" = 'credential' AND password IS NOT NULL
    ) AS yes`.execute(authPool());
  return r.rows[0]?.yes === true;
}

/** Tell the account its sign-in factors changed (`line` says how), where SMTP is configured. */
export function mailFactorChange(to: string, line: string): void {
  if (!isEmailConfigured()) return;
  sendEmail({
    to,
    subject: 'Your sign-in methods changed',
    html: `<p>${line}</p><p>If this was not you, sign in and review your security settings, or contact your administrator.</p>`,
    text: `${line}\n\nIf this was not you, sign in and review your security settings, or contact your administrator.`,
  }).catch((err: Error) => console.error('[step-up] factor-change mail failed:', err.message));
}

/** Better Auth's endpoints that create a session from an OAuth provider's answer. */
const OAUTH_SIGN_IN_PATHS = new Set(['/callback/:id', '/sign-in/social']);
const OAUTH_SIGN_IN_SECONDS = 300;

/**
 * Note a session an OAuth sign-in is creating; called from Better Auth's session
 * create hook, the one place that sees both the new token and the endpoint. The
 * session row records neither the method nor survives a replacement unchanged, so
 * this row — five minutes, keyed by the token's hash — is the record.
 */
export async function noteSessionOrigin(token: string, path: string | undefined): Promise<void> {
  if (!path || !OAUTH_SIGN_IN_PATHS.has(path)) return;
  await put(rowId('oauth-sign-in', token), 'oauth-sign-in', '', OAUTH_SIGN_IN_SECONDS);
}

/**
 * What enrolls this account's first factor: its password; or, with none, this
 * session if an OAuth sign-in created it at most five minutes ago, else a new sign-in.
 */
export type FirstFactor = 'password' | 'recent_sign_in' | 'sign_in_again';

export async function firstFactorRule(userId: string, sessionToken: string): Promise<FirstFactor> {
  if (await hasPassword(userId)) return 'password';
  const r = await sql<{ id: string }>`
    SELECT id FROM verification
     WHERE id = ${rowId('oauth-sign-in', sessionToken)} AND "expiresAt" > now()`.execute(
    authPool(),
  );
  return r.rows.length === 1 ? 'recent_sign_in' : 'sign_in_again';
}

/** Store a row; false when one with this id is already there (a replayed TOTP code). */
async function put(id: string, kind: string, value: string, ttl = TTL_SECONDS): Promise<boolean> {
  const db = authPool();
  // Better Auth never reads these, so nothing else sweeps them.
  await sql`DELETE FROM verification
             WHERE identifier LIKE 'step-up:%' AND "expiresAt" < now()`.execute(db);
  const r = await sql<{ id: string }>`
    INSERT INTO verification (id, identifier, value, "expiresAt")
    VALUES (${id}, ${`step-up:${kind}`}, ${value}, now() + make_interval(secs => ${ttl}))
    ON CONFLICT (id) DO NOTHING RETURNING id`.execute(db);
  return r.rows.length === 1;
}

/**
 * Wrong TOTP codes an account may send to step-up per window. The per-IP auth
 * limit alone let a stolen session guess from as many addresses as it had: one
 * code in ~333k is accepted, and nothing counted per account.
 */
const TOTP_MAX_FAILURES = 5;
const TOTP_FAILURE_SECONDS = 900;

/**
 * Reserve one TOTP attempt for `userId`: the row's id when it is within the
 * budget, else null. Reserved before the code is checked, so concurrent guesses
 * each see the others' rows and at most `TOTP_MAX_FAILURES` get through.
 */
async function reserveTotpAttempt(userId: string): Promise<string | null> {
  const id = rowId('totp-attempt', randomBytes(16).toString('base64url'));
  const kind = `totp-attempt:${userId}`;
  await put(id, kind, '', TOTP_FAILURE_SECONDS);
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM verification
     WHERE identifier = ${`step-up:${kind}`} AND "expiresAt" > now()`.execute(authPool());
  if ((r.rows[0]?.n ?? 0) <= TOTP_MAX_FAILURES) return id;
  await take(id); // A refused attempt does not extend the lock.
  return null;
}

/** Delete and return a live row: the one statement makes it single-use under concurrency. */
async function take(id: string): Promise<string | null> {
  const r = await sql<{ value: string }>`
    DELETE FROM verification WHERE id = ${id} AND "expiresAt" > now() RETURNING value`.execute(
    authPool(),
  );
  return r.rows[0]?.value ?? null;
}

/** `first_factor` rides in `errors`, the one extra member the problem+json envelope keeps. */
const enrollmentRequired = (c: Context, firstFactor?: FirstFactor) =>
  c.json(
    {
      error:
        'This action needs a passkey or an authenticator app on your account. Add one in your security settings first.',
      code: 'step_up_enrollment_required',
      ...(firstFactor ? { errors: { first_factor: firstFactor } } : {}),
    },
    403,
  );

/** POST /api/auth/step-up/options — what the client must present for `action`. */
export async function stepUpOptions(c: Context): Promise<Response> {
  const session = await requestSession(c, auth);
  if (!session) return refuseWithoutSession(c);
  const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
  if (!isStepUpAction(body.action)) return c.json({ error: 'A valid action is required' }, 400);

  const { passkeys, totp } = await factorsOf(session.user.id);
  if (passkeys.length > 0) {
    const options = await generateAuthenticationOptions({
      rpID: passkeyRelyingParty().rpID,
      userVerification: 'required',
      timeout: TTL_SECONDS * 1000,
      allowCredentials: passkeys.map((p) => ({
        id: p.credentialID,
        transports: p.transports?.split(',').filter(Boolean) as AuthenticatorTransportFuture[],
      })),
    });
    await put(
      rowId('challenge', options.challenge, session.session.id, body.action),
      'challenge',
      '',
    );
    // `totp`: the authenticator app is accepted too, for a key that cannot verify its user.
    return c.json({ method: 'passkey', action: body.action, options, totp });
  }
  if (totp) return c.json({ method: 'totp', action: body.action });
  return enrollmentRequired(c, await firstFactorRule(session.user.id, session.session.token));
}

/** POST /api/auth/step-up/verify — a passkey assertion or TOTP code in, a token out. */
export async function stepUpVerify(c: Context): Promise<Response> {
  const session = await requestSession(c, auth);
  if (!session) return refuseWithoutSession(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: unknown;
    response?: AuthenticationResponseJSON;
    code?: unknown;
  };
  const action = body.action;
  if (!isStepUpAction(action)) return c.json({ error: 'A valid action is required' }, 400);
  const sessionId = session.session.id;
  const userId = session.user.id;
  const refuse = (error: string) => c.json({ error, code: 'step_up_failed' }, 403);

  const { passkeys, totp } = await factorsOf(userId);
  let method: StepUpMethod;
  // A code is taken whenever TOTP is enrolled, beside a passkey too (owner, 2026-10-18).
  if (passkeys.length > 0 && !(totp && body.code !== undefined)) {
    const resp = body.response;
    let challenge: unknown;
    try {
      challenge = JSON.parse(
        Buffer.from(resp?.response?.clientDataJSON ?? '', 'base64url').toString('utf8'),
      ).challenge;
    } catch {
      return refuse('A passkey assertion is required');
    }
    if (typeof challenge !== 'string') return refuse('A passkey assertion is required');
    if ((await take(rowId('challenge', challenge, sessionId, action))) === null) {
      return refuse('The challenge is unknown, expired, or for another action');
    }
    const pk = passkeys.find((p) => p.credentialID === resp?.id);
    if (!resp || !pk) return refuse('That passkey is not registered to this account');
    // A security key with no PIN signs on a touch: that proves a key, not its owner.
    const flags = Buffer.from(resp.response.authenticatorData ?? '', 'base64url')[32] ?? 0;
    if (!(flags & 0x04)) {
      return c.json(
        {
          error: `This passkey confirmed a touch but not you. Set a PIN or turn on fingerprint or face unlock for it, then try again${totp ? ', or use the code from your authenticator app' : ''}.`,
          code: 'step_up_user_verification_required',
        },
        403,
      );
    }
    const { rpID, origin } = passkeyRelyingParty();
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: resp,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: pk.credentialID,
          publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64')),
          counter: pk.counter,
        },
        // Unlike Better Auth's passkey sign-in, which takes presence alone.
        requireUserVerification: true,
      });
    } catch {
      return refuse('The passkey assertion did not verify');
    }
    if (!verification.verified) return refuse('The passkey assertion did not verify');
    // Compare-and-set: two concurrent assertions read the same stored counter and
    // both verify; only the one whose update lands counts. An authenticator that
    // never counts (0 stored, 0 sent) is left alone, as the library allows.
    const newCounter = verification.authenticationInfo.newCounter;
    const advanced = await sql`UPDATE passkey SET counter = ${newCounter}
               WHERE id = ${pk.id}
                 AND (counter < ${newCounter} OR (counter = 0 AND ${newCounter} = 0))
               RETURNING id`.execute(authPool());
    if (advanced.rows.length === 0) return refuse('The passkey assertion did not verify');
    method = 'passkey';
  } else if (totp) {
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      return refuse('A 6-digit code is required');
    const attempt = await reserveTotpAttempt(userId);
    if (!attempt) {
      return c.json(
        {
          error: 'Too many wrong codes. Wait a few minutes, then try again.',
          code: 'step_up_locked',
        },
        429,
      );
    }
    try {
      // Better Auth's own check, against its encrypted secret; with a session it
      // verifies and creates nothing.
      await (auth.api as unknown as TotpApi).verifyTOTP({
        headers: c.req.raw.headers,
        body: { code },
      });
    } catch {
      return refuse('The code is not valid'); // The attempt row stays: it was a guess.
    }
    await take(attempt);
    // A code stays valid for its whole window; one code mints one token.
    if (!(await put(rowId('totp', userId, code), 'totp', ''))) {
      return refuse('This code was already used. Wait for the next one.');
    }
    method = 'totp';
  } else {
    return enrollmentRequired(c);
  }

  const token = randomBytes(32).toString('base64url');
  await put(rowId('token', token, sessionId, action), 'token', method);
  await openConfigWindow(sessionId, method);
  return c.json({ token, method, action, expires_in: TTL_SECONDS });
}

/**
 * How long a step-up opens configuration changes to its session (ADR 0006: an
 * XSS in the App riding an administrator's cookie meets this, not the cookie
 * alone). Fixed from the step-up, never slid by use. Any step-up opens it, so
 * the per-action ones (extensions, factors) that ask a token on top count too.
 */
export const CONFIG_WINDOW_SECONDS = 300;
/** The action a configuration refusal names: the client steps up for it and retries. */
export const CONFIG_ACTION = 'config';

async function openConfigWindow(sessionId: string, method: StepUpMethod): Promise<void> {
  await sql`
    INSERT INTO verification (id, identifier, value, "expiresAt")
    VALUES (${rowId('window', sessionId)}, 'step-up:window', ${method},
            now() + make_interval(secs => ${CONFIG_WINDOW_SECONDS}))
    ON CONFLICT (id) DO UPDATE SET value = excluded.value, "expiresAt" = excluded."expiresAt"
  `.execute(authPool());
}

/**
 * Null when the session's configuration window is open (publishing how it was
 * opened as `stepUpMethod`); else the 403: `step_up_required` naming
 * `CONFIG_ACTION`, or `step_up_enrollment_required` when there is no factor yet.
 */
export async function requireConfigWindow(
  c: Context,
  session: RequestSession,
): Promise<Response | null> {
  const r = await sql<{ value: string }>`
    SELECT value FROM verification
     WHERE id = ${rowId('window', session.session.id)} AND "expiresAt" > now()`.execute(authPool());
  const method = r.rows[0]?.value;
  if (method === 'passkey' || method === 'totp') {
    c.set('stepUpMethod', method);
    return null;
  }
  if (!(await hasStepUpFactor(session.user.id))) return enrollmentRequired(c);
  return c.json(
    {
      error: 'Configuration changes need a fresh step-up confirmation',
      code: 'step_up_required',
      errors: { action: CONFIG_ACTION },
    },
    403,
  );
}

/**
 * Spend the request's step-up token for `action`. The method it was earned with,
 * also published as `stepUpMethod`; or the 403 to answer with.
 */
export async function requireStepUp(c: Context, action: string): Promise<StepUpMethod | Response> {
  const session = await requestSession(c, auth);
  if (!session) return refuseWithoutSession(c);
  const token = c.req.header(STEP_UP_HEADER);
  if (token) {
    const method = await take(rowId('token', token, session.session.id, action));
    if (method === 'passkey' || method === 'totp') {
      c.set('stepUpMethod', method);
      return method;
    }
  }
  if (!(await hasStepUpFactor(session.user.id))) return enrollmentRequired(c);
  return c.json(
    // `action` rides in `errors`, the one extra member problem+json keeps: the
    // client steps up for it and retries (Studio lib/api.ts).
    {
      error: 'This action needs a fresh step-up confirmation',
      code: 'step_up_required',
      errors: { action },
    },
    403,
  );
}
