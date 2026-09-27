/**
 * The sign-in block every session creator asks. The SSO session bridge itself
 * (`createBetterAuthSession`) lives in `lib/users.ts`: it writes through
 * better-auth, which this file must not import — the worker runtime inlines it.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const SIGN_IN_BLOCKED = 'This account is disabled.';

/** A refused sign-in. `code` matches the one better-auth's hook answers with,
 *  so an SSO extension can answer 403 instead of a 500. */
export class SignInBlockedError extends Error {
  readonly code = 'account_disabled';
  constructor() {
    super(SIGN_IN_BLOCKED);
    this.name = 'SignInBlockedError';
  }
}

/**
 * Whether `userId` may not sign in (`"user".banned`, set by `setUserActive` in
 * `lib/users.ts`). Asked wherever a session is created: better-auth's
 * `session.create.before` hook (password, magic link, passkey, OAuth,
 * two-factor) and `createBetterAuthSession` in `lib/users.ts`, which checks the
 * caller's own transaction first. Kept here, free of imports, because the worker
 * runtime inlines this file.
 */
export async function isSignInBlocked(db: Database, userId: string): Promise<boolean> {
  const r = await sql<{ banned: boolean | null }>`
    SELECT banned FROM "user" WHERE id = ${userId}
  `.execute(db);
  return r.rows[0]?.banned === true;
}
