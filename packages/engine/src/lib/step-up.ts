/**
 * God step-up (RFC extension model v3, "Installing and trusting code", item 3).
 *
 * A session alone does not install code. A mutation that does asks for a token
 * minted by a fresh passkey assertion — or a TOTP code, for an account that has
 * no passkey — bound to that session and to one named action, good for two
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
import { requestSession } from '../middleware/session-prefetch.js';
import { refuseWithoutSession } from './admin-guard.js';

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

/** Store a row; false when one with this id is already there (a replayed TOTP code). */
async function put(id: string, kind: string, value: string): Promise<boolean> {
  const db = authPool();
  // Better Auth never reads these, so nothing else sweeps them.
  await sql`DELETE FROM verification
             WHERE identifier LIKE 'step-up:%' AND "expiresAt" < now()`.execute(db);
  const r = await sql<{ id: string }>`
    INSERT INTO verification (id, identifier, value, "expiresAt")
    VALUES (${id}, ${`step-up:${kind}`}, ${value}, now() + interval '120 seconds')
    ON CONFLICT (id) DO NOTHING RETURNING id`.execute(db);
  return r.rows.length === 1;
}

/** Delete and return a live row: the one statement makes it single-use under concurrency. */
async function take(id: string): Promise<string | null> {
  const r = await sql<{ value: string }>`
    DELETE FROM verification WHERE id = ${id} AND "expiresAt" > now() RETURNING value`.execute(
    authPool(),
  );
  return r.rows[0]?.value ?? null;
}

const enrollmentRequired = (c: Context) =>
  c.json(
    {
      error:
        'This action needs a passkey or an authenticator app on your account. Add one in your security settings first.',
      code: 'step_up_enrollment_required',
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
      userVerification: 'preferred',
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
    return c.json({ method: 'passkey', action: body.action, options });
  }
  if (totp) return c.json({ method: 'totp', action: body.action });
  return enrollmentRequired(c);
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
  if (passkeys.length > 0) {
    // TOTP is refused here: a passkey on the account is the factor that counts.
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
        // As Better Auth's own passkey sign-in: presence, not necessarily a PIN.
        requireUserVerification: false,
      });
    } catch {
      return refuse('The passkey assertion did not verify');
    }
    if (!verification.verified) return refuse('The passkey assertion did not verify');
    await sql`UPDATE passkey SET counter = ${verification.authenticationInfo.newCounter}
               WHERE id = ${pk.id}`.execute(authPool());
    method = 'passkey';
  } else if (totp) {
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      return refuse('A 6-digit code is required');
    try {
      // Better Auth's own check, against its encrypted secret; with a session it
      // verifies and creates nothing.
      await (auth.api as unknown as TotpApi).verifyTOTP({
        headers: c.req.raw.headers,
        body: { code },
      });
    } catch {
      return refuse('The code is not valid');
    }
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
  return c.json({ token, method, action, expires_in: TTL_SECONDS });
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
    { error: 'This action needs a fresh step-up confirmation', code: 'step_up_required', action },
    403,
  );
}
