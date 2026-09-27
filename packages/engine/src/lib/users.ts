/**
 * Deleting a user, and taking their access away, in ONE place.
 *
 * `DELETE /api/users/:id` was the only caller that did it right. SCIM
 * deprovisioning and GDPR erasure deleted the row with raw SQL, so a user they
 * removed left no `user.deleted` row (the evidence migration 017 prunes by) and
 * their sessions were never revoked: the `session` delete is refused to
 * `zveltio_rls` since migration 044 — SCIM answered 500 to every offboarding —
 * and with Valkey, better-auth keeps sessions only in `secondaryStorage`, which
 * no SQL reaches. The erased user's cookie kept signing them in.
 */

import { generateRandomString, makeSignature } from 'better-auth/crypto';
import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auditLog } from './audit.js';
import { getAuth, revokeAllUserSessions } from './auth.js';
import { isSignInBlocked, SignInBlockedError } from './security/index.js';
import {
  getCurrentTenantTrx,
  getEnforcer,
  invalidateUserPermCache,
  onAfterCommit,
} from './tenancy/index.js';

/**
 * The instance owner (`role = 'god'`) is demoted in the engine, never deleted or
 * locked out from here: an IdP sync or an erasure request must not be able to
 * leave the instance without its owner. `code` is what an extension matches on.
 */
export class ProtectedUserError extends Error {
  readonly code = 'user_protected';
  constructor(userId: string, what: string) {
    super(
      `User ${userId} is the instance owner (god) and cannot be ${what}. ` +
        'Transfer or demote the god role in the engine first.',
    );
    this.name = 'ProtectedUserError';
  }
}

// On the caller's handle and without `isGodUser`'s fallback: that answers
// "not god" when the lookup fails, which here would let the ban through.
// FOR UPDATE holds the row until the caller's transaction ends, so the user
// cannot be promoted to god between this check and the ban or delete.
async function refuseGod(db: Database, userId: string, what: string): Promise<void> {
  const r = await sql<{ role: string }>`
    SELECT role FROM "user" WHERE id = ${userId} FOR UPDATE`.execute(db);
  if (r.rows[0]?.role === 'god') throw new ProtectedUserError(userId, what);
}

/** Who deleted a user and why — what the `user.deleted` audit row records. */
export interface UserDeletion {
  /** The signed-in user who asked. `zv_audit_log.user_id` references "user", so
   *  an actor that is not a user row (a SCIM token, the erased subject) leaves
   *  it unset and names itself in `actor`. */
  actorUserId?: string | null;
  /** A non-user actor, e.g. `scim:<token id>`. */
  actor?: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Delete `userId` the way the admin route does, in its order. `db` carries the
 * row delete and the audit row — the caller's transaction, so they commit with
 * it; `poolDb` is the privileged pool that alone may touch `session`. Resolves
 * `false`, having touched nothing, when there is no such user.
 */
export async function deleteUser(
  db: Database,
  poolDb: Database,
  userId: string,
  who: UserDeletion,
): Promise<boolean> {
  // Before anything touches the id: `e.deleteUser` removes every Casbin row
  // whose subject is this string, and a role name sits in the same column.
  // Raw SQL, because an extension hands over a handle whose builder refuses "user".
  const found = await sql`SELECT 1 FROM "user" WHERE id = ${userId}`.execute(db);
  if (found.rows.length === 0) return false;
  await refuseGod(db, userId, 'deleted');

  // Sessions, then grants, then the row: a failure part-way leaves a user who
  // cannot sign in or has no grants — never a deleted user who still can.
  await revokeThroughCommit(poolDb, userId);
  // Through the enforcer, so this instance's model and the watcher's peers drop
  // the grants now; migration 017's trigger only catches the table.
  const e = await getEnforcer();
  await e.deleteUser(userId);
  await invalidateUserPermCache(userId);

  await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db);

  await auditLog(db, {
    type: 'user.deleted',
    userId: who.actorUserId ?? undefined,
    resourceId: userId,
    resourceType: 'user',
    metadata: { ...(who.actor ? { actor: who.actor } : {}), reason: who.reason, ...who.metadata },
  });
  return true;
}

/** End every session `userId` has (but `exceptToken`), in the database and the
 *  cache. On the privileged pool — see `deleteUser`. */
export async function revokeUserSessions(
  poolDb: Database,
  userId: string,
  exceptToken?: string,
): Promise<void> {
  await revokeAllUserSessions(poolDb, userId, exceptToken);
}

/**
 * Let `userId` sign in again, or stop them signing in by ANY method.
 *
 * `isSignInBlocked` refuses `"user".banned` wherever a session is created,
 * and the credentials are left alone: reactivating clears it and the password,
 * passkeys and SSO links work again. SCIM cleared the password instead — a
 * passkey, a magic link and OAuth still signed the user in, and reactivation
 * could not give the password back.
 *
 * The flag goes on `db`, the caller's transaction: on the pool it waited for the
 * row lock of a caller that had just written the same row (SCIM PUT renames the
 * user first) and the request hung. So it is invisible until commit, and the
 * sessions are revoked again then — see `revokeThroughCommit`.
 */
export async function setUserActive(
  db: Database,
  poolDb: Database,
  userId: string,
  active: boolean,
): Promise<void> {
  if (!active) await refuseGod(db, userId, 'deactivated');
  // IdPs resend `active: true` on every sync; only a change touches the row.
  await sql`
    UPDATE "user" SET banned = ${!active}, "updatedAt" = NOW()
     WHERE id = ${userId} AND COALESCE(banned, false) <> ${!active}
  `.execute(db);
  if (!active) await revokeThroughCommit(poolDb, userId);
}

/**
 * Revoke now, and again once the request's transaction commits. A sign-in that
 * lands before the commit does not see the ban or the deletion yet, and would
 * otherwise keep its session — with Valkey, past even the row's cascade.
 */
async function revokeThroughCommit(poolDb: Database, userId: string): Promise<void> {
  await revokeAllUserSessions(poolDb, userId);
  if (getCurrentTenantTrx()) onAfterCommit(() => revokeAllUserSessions(poolDb, userId));
}

/** Options for {@link createBetterAuthSession}. */
export interface CreateSsoSessionOptions {
  ipAddress?: string;
  userAgent?: string;
  ttlSeconds?: number;
  /** `SameSite=None; Secure`, for a Studio on another origin. HTTPS only. */
  crossDomain?: boolean;
  /** End the user's other sessions once this one is written and the request
   *  committed: one live SSO session per user. */
  replaceExisting?: boolean;
}

/**
 * Sign in a user an extension has verified (LDAP, SAML): the session where
 * better-auth looks for it, and the cookie it reads.
 *
 * LDAP and SAML inserted the `session` row themselves, on the request's
 * transaction — as `zveltio_rls`, refused `session` since migration 044, so every
 * SSO login answered 500. And with Valkey better-auth keeps sessions only in
 * `secondaryStorage`, where a row is never looked for. So better-auth writes it:
 * its own pool, its storage, its `session.create` hook (the ban check).
 *
 * `db` is the caller's transaction, asked first whether the user is blocked so a
 * ban in that transaction counts. A user that transaction created is invisible to
 * better-auth's pool until the commit, so their session is written then: before
 * the response, which `withTenantIsolation` holds for its after-commit work, and
 * never if the transaction rolls back.
 *
 * Users and sessions are instance-wide, so an extension holding `auth:session`
 * can sign in any user row; tenant membership is enforced per request by
 * `tenantMembershipMiddleware`. That is the capability's documented meaning,
 * not a bypass.
 */
export async function createBetterAuthSession(
  db: Database,
  poolDb: Database,
  userId: string,
  opts: CreateSsoSessionOptions = {},
): Promise<{ token: string; setCookie: string }> {
  if (await isSignInBlocked(db, userId)) throw new SignInBlockedError();
  const ctx = await getAuth().$context;
  const ttl = opts.ttlSeconds ?? ctx.sessionConfig.expiresIn;
  const token = generateRandomString(32, 'a-z', 'A-Z', '0-9');

  const trx = getCurrentTenantTrx();
  // The others go only once the new session exists AND the request committed,
  // sparing the new one: a write that fails, or a request that rolls back, must
  // not sign the user out of everywhere.
  const revokeOthers = () => revokeUserSessions(poolDb, userId, token);
  const write = async () => {
    await ctx.internalAdapter.createSession(
      userId,
      false,
      {
        token,
        expiresAt: new Date(Date.now() + ttl * 1000),
        ...(opts.ipAddress ? { ipAddress: opts.ipAddress } : {}),
        ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      },
      true,
    );
  };
  const committed = async () =>
    (await sql`SELECT 1 FROM "user" WHERE id = ${userId}`.execute(poolDb)).rows.length > 0;
  if (await committed()) {
    await write();
    if (opts.replaceExisting) {
      if (trx) onAfterCommit(revokeOthers);
      else await revokeOthers();
    }
  } else if (trx) {
    // Asked again after the commit: a savepoint the caller rolled back may have
    // taken the user with it, and better-auth would cache a session for no one.
    onAfterCommit(async () => {
      if (!(await committed())) return;
      await write();
      if (opts.replaceExisting) await revokeOthers();
    });
  } else throw new Error(`No user ${userId} to sign in.`);

  const cookie = ctx.authCookies.sessionToken;
  const value = encodeURIComponent(`${token}.${await makeSignature(token, ctx.secret)}`);
  const parts = [`${cookie.name}=${value}`, 'Path=/', 'HttpOnly', `Max-Age=${ttl}`];
  if (opts.crossDomain) parts.push('SameSite=None', 'Secure');
  else {
    const sameSite = String(cookie.attributes.sameSite ?? 'lax').toLowerCase();
    parts.push(`SameSite=${sameSite[0]?.toUpperCase()}${sameSite.slice(1)}`);
    if (cookie.attributes.secure) parts.push('Secure');
  }
  return { token, setCookie: parts.join('; ') };
}
