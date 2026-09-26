/**
 * SSO session bridge — creates a Better-Auth-compatible session for users
 * who were authenticated out-of-band (SAML, LDAP, OIDC, custom).
 *
 * Three things need to match exactly for `auth.api.getSession({ headers })`
 * to accept the cookie a SSO provider sets:
 *
 *   1. The `session` table row uses camelCase columns (`userId`, `expiresAt`,
 *      `createdAt`, `updatedAt`, `ipAddress`, `userAgent`) — see the
 *      Better-Auth migration in 001_auth.sql. Snake_case inserts fail at
 *      runtime ("column user_id does not exist").
 *
 *   2. The session cookie value is signed with HMAC-SHA256 over the token
 *      using BETTER_AUTH_SECRET, formatted as `${token}.${base64(signature)}`,
 *      then URL-encoded. This matches Hono's `setSignedCookie()` which
 *      Better-Auth uses internally.
 *
 *   3. The cookie name is `better-auth.session_token` (or
 *      `__Secure-better-auth.session_token` in secure contexts, but
 *      Better-Auth handles both prefixes when reading).
 *
 * This helper exists so each SSO extension doesn't re-derive the format and
 * silently desync from Better-Auth's expectations.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const SIGN_IN_BLOCKED = 'This account is disabled.';

/**
 * Whether `userId` may not sign in (`"user".banned`, set by `setUserActive` in
 * `lib/users.ts`). Asked wherever a session is created: better-auth's
 * `session.create.before` hook (password, magic link, passkey, OAuth,
 * two-factor) and `createBetterAuthSession` below, which inserts its row itself
 * and so never reaches that hook. Kept here, free of imports, because the worker
 * runtime inlines this file.
 */
export async function isSignInBlocked(db: Database, userId: string): Promise<boolean> {
  const r = await sql<{ banned: boolean | null }>`
    SELECT banned FROM "user" WHERE id = ${userId}
  `.execute(db);
  return r.rows[0]?.banned === true;
}

export interface CreateSsoSessionOptions {
  ipAddress?: string;
  userAgent?: string;
  ttlSeconds?: number;
  /**
   * When true, emit `SameSite=None; Secure` so the cookie survives a
   * cross-origin redirect (Studio at one domain, engine at another). The
   * `Secure` flag is required by browsers whenever `SameSite=None` is set,
   * so this only works on HTTPS deployments.
   *
   * Default (false) uses `SameSite=Lax; Secure` (when NODE_ENV=production),
   * which works for same-site setups and stops most CSRF.
   */
  crossDomain?: boolean;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 3600; // 7 days

async function makeSignature(value: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Generate a session token shaped like Better-Auth's: 32 url-safe chars.
 * Use crypto.getRandomValues so the entropy matches Better-Auth's
 * generateId(32) (which is also crypto-random).
 */
function generateSessionToken(): string {
  const bytes = new Uint8Array(24); // 24 bytes → 32 base64url chars
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createBetterAuthSession(
  db: Database,
  userId: string,
  opts: CreateSsoSessionOptions = {},
): Promise<{ token: string; setCookie: string }> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error('[sso-session] BETTER_AUTH_SECRET is not set — cannot sign session cookie.');
  }
  // This insert bypasses better-auth, and so its session hook: the one other
  // place a deactivated user has to be refused.
  if (await isSignInBlocked(db, userId)) throw new Error(SIGN_IN_BLOCKED);

  const token = generateSessionToken();
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl * 1000);

  // Use the EXACT column casing Better-Auth's adapter expects. The TS
  // schema in db/schema.ts is camelCase and PostgreSQL columns are
  // quoted camelCase ("userId", "expiresAt", …) — a snake_case insert
  // fails outright. Raw SQL keeps the casing literal.
  await sql`
    INSERT INTO session (id, token, "userId", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt")
    VALUES (
      ${crypto.randomUUID()},
      ${token},
      ${userId},
      ${expiresAt},
      ${opts.ipAddress ?? null},
      ${opts.userAgent ?? null},
      ${now},
      ${now}
    )
  `.execute(db);

  // Sign the token the same way Hono.setSignedCookie does so Better-Auth's
  // cookie parser accepts it. Format: `${token}.${base64(HMAC)}`, then
  // URL-encoded as a whole.
  const signature = await makeSignature(token, secret);
  const cookieValue = encodeURIComponent(`${token}.${signature}`);

  const inProd = process.env.NODE_ENV === 'production';
  const sameSite = opts.crossDomain ? 'None' : 'Lax';
  // SameSite=None *requires* Secure (browser enforced). In dev with
  // NODE_ENV unset we still emit Secure when crossDomain is requested —
  // the dev will need https for cross-origin auth anyway.
  const secure = inProd || opts.crossDomain;

  const parts = [
    `better-auth.session_token=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${ttl}`,
  ];
  if (secure) parts.push('Secure');

  return { token, setCookie: parts.join('; ') };
}
