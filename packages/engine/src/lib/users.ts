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

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auditLog } from './audit.js';
import { revokeAllUserSessions } from './auth.js';
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

/** End every session `userId` has, in the database and the cache. On the
 *  privileged pool — see `deleteUser`. */
export async function revokeUserSessions(poolDb: Database, userId: string): Promise<void> {
  await revokeAllUserSessions(poolDb, userId);
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
