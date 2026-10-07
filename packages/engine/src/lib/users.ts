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
import { engineHandle } from './engine-handle.js';
import { getAuth, revokeAllUserSessions } from './auth.js';
import { withSavepoint } from './savepoint.js';
import { isSignInBlocked, SignInBlockedError } from './security/index.js';
import {
  getCurrentTenantTrx,
  getEnforcer,
  invalidateUserPermCache,
  isGodUser,
  isMemberBaseline,
  onAfterCommit,
  requireInstanceAdmin,
  withEveryTenant,
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
  callerDb: Database,
  poolDb: Database,
  userId: string,
  who: UserDeletion,
): Promise<boolean> {
  // The caller's handle may be an extension's `ctx.db`, which refuses raw SQL on
  // `user`; this is the engine's own SQL, so it runs on the engine's view.
  const db = engineHandle(callerDb);
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

  // Their API keys stop too. The FK only sets `created_by` NULL, which left a
  // deleted user's keys working while a deactivated user's were refused.
  // Revoked, not deleted: the access log cascades with the key row, and it is
  // the record an offboarding is audited against.
  await sql`UPDATE zv_api_keys SET is_active = false
             WHERE created_by = ${userId} AND is_active`.execute(db);

  await sql`DELETE FROM "user" WHERE id = ${userId}`.execute(db);

  await auditLog(db, {
    type: 'user.deleted',
    tenantId: null,
    userId: who.actorUserId ?? undefined,
    resourceId: userId,
    resourceType: 'user',
    metadata: { ...(who.actor ? { actor: who.actor } : {}), reason: who.reason, ...who.metadata },
  });
  return true;
}

/** Why a purged tenant's member kept their account. */
export type KeptReason = 'self' | 'god' | 'instance_admin' | 'other_tenant' | 'other_grants';

export interface TenantlessUsers {
  deleted: string[];
  kept: { id: string; reason: KeptReason }[];
  failed: { id: string; error: string }[];
}

/**
 * After a tenant purge: delete the accounts of its members that belong nowhere
 * else now, each through `deleteUser`. Kept: the requester, god, an instance
 * admin, a member of any other tenant (archived included — archiving is
 * undone by one PATCH), and anyone holding a Casbin rule outside the purged
 * domain — the default tenant has no membership row, a grant is how a user of
 * it is told apart from an empty account.
 *
 * In a transaction of its own on `db` (the purge's has committed by now — see
 * `purgeTenant`), one savepoint per user,
 * so a failure is reported and the others go on. The sessions and grants
 * `deleteUser` removes first are not transactional: a failed user is left
 * unable to sign in, never deleted and still able to.
 */
export async function deleteTenantlessUsers(
  db: Database,
  poolDb: Database,
  tenant: { id: string; slug: string },
  memberIds: string[],
  requesterId: string,
): Promise<TenantlessUsers> {
  const out: TenantlessUsers = { deleted: [], kept: [], failed: [] };
  const e = await getEnforcer();
  const settle = async (trx: Database, id: string): Promise<KeptReason | 'deleted' | null> => {
    if (id === requesterId) return 'self';
    if (await isGodUser(id)) return 'god';
    if (await requireInstanceAdmin(id)) return 'instance_admin';
    // Locked before the membership read: an insert into zv_tenant_users takes
    // KEY SHARE on this row, so it either committed already and is seen below,
    // or waits for our commit and then fails its foreign key.
    const row = await sql`SELECT 1 FROM "user" WHERE id = ${id} FOR UPDATE`.execute(trx);
    if (row.rows.length === 0) return null;
    // ANY row, lapsed included — deliberately not `activeMembership`. An expired
    // membership is the other tenant's history, and deleting the account would
    // cascade it away; a purge of one tenant must not edit another's records.
    const member = await sql`SELECT 1 FROM zv_tenant_users WHERE user_id = ${id} LIMIT 1`.execute(
      trx,
    );
    if (member.rows.length) return 'other_tenant';
    const roles = (await e.getFilteredGroupingPolicy(0, id)).filter(
      (r) => r[2] !== tenant.id && !isMemberBaseline(r),
    );
    const rules = (await e.getFilteredPolicy(0, id)).filter((r) => r[1] !== tenant.id);
    if (roles.length || rules.length) return 'other_grants';
    const gone = await deleteUser(trx, poolDb, id, {
      actorUserId: requesterId,
      reason: 'tenant_purge',
      metadata: { tenant_id: tenant.id, tenant_slug: tenant.slug },
    });
    return gone ? 'deleted' : null;
  };
  await db.transaction().execute(async (trx) => {
    for (const id of memberIds) {
      const r = await withSavepoint(
        trx,
        'zv_purge_user',
        () => settle(trx, id),
        (err) => {
          // The FOR UPDATE check inside `deleteUser` — a promotion that raced ours.
          if (err instanceof ProtectedUserError) return 'god' as const;
          out.failed.push({ id, error: (err as Error)?.message ?? String(err) });
          return null;
        },
      );
      if (r === 'deleted') out.deleted.push(id);
      else if (r) out.kept.push({ id, reason: r });
    }
  });
  return out;
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

/** What the engine holds about one user, for a data-subject access request. */
export interface UserDataExport {
  profile: { id: string; name: string | null; email: string; created_at: string } | null;
  /** The user's own actions, in every tenant and at instance level; newest 1000. */
  audit_log: Array<{
    action: string;
    collection: string | null;
    record_id: string | null;
    created_at: string;
  }>;
  /** Newest 500. */
  notifications: Array<{
    title: string;
    message: string | null;
    type: string | null;
    is_read: boolean;
    created_at: string;
  }>;
  /** Keys the user created — names and prefixes, never a secret. */
  api_keys: Array<{ name: string; key_prefix: string | null; scopes: unknown; created_at: string }>;
  approval_requests: Array<{
    id: string;
    collection: string;
    record_id: string | null;
    status: string;
    requested_at: string;
  }>;
}

/**
 * Everything the engine's own tables hold about `userId` (GDPR art. 15), or
 * null when there is no such user. Every tenant's rows: they are the subject's
 * data whichever tenant recorded them, and a tenant-scoped read left the
 * instance-level ones (sign-ins) and the other tenants' out of the export.
 * Read in one `withEveryTenant` transaction on the engine's pool — READ
 * COMMITTED, so each statement sees its own snapshot, not one for the export.
 */
export async function exportUserData(
  poolDb: Database,
  userId: string,
): Promise<UserDataExport | null> {
  return withEveryTenant(poolDb, async (trx) => {
    const profile = (
      await sql<NonNullable<UserDataExport['profile']>>`
        SELECT id, name, email, "createdAt" AS created_at FROM "user" WHERE id = ${userId}`.execute(
        trx,
      )
    ).rows[0];
    if (!profile) return null;
    const audit = await sql<UserDataExport['audit_log'][number]>`
      SELECT event_type AS action, resource_type AS collection, resource_id AS record_id, created_at
        FROM zv_audit_log WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1000`.execute(
      trx,
    );
    const notifications = await sql<UserDataExport['notifications'][number]>`
      SELECT title, message, type, is_read, created_at FROM zv_notifications
       WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 500`.execute(trx);
    const keys = await sql<UserDataExport['api_keys'][number]>`
      SELECT name, key_prefix, scopes, created_at FROM zv_api_keys
       WHERE created_by = ${userId} ORDER BY created_at`.execute(trx);
    // Created by the approvals feature's migration, so absent on an install
    // that never ran it.
    const hasApprovals = (
      await sql<{
        t: string | null;
      }>`SELECT to_regclass('zv_approval_requests')::text AS t`.execute(trx)
    ).rows[0]?.t;
    const approvals = hasApprovals
      ? (
          await sql<UserDataExport['approval_requests'][number]>`
            SELECT id::text, collection, record_id, status, requested_at FROM zv_approval_requests
             WHERE requested_by = ${userId} ORDER BY requested_at DESC`.execute(trx)
        ).rows
      : [];
    return {
      profile,
      audit_log: audit.rows,
      notifications: notifications.rows,
      api_keys: keys.rows,
      approval_requests: approvals,
    };
  });
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
 *
 * A ban records `source` (`ext:<name>`, bound by the extension gate) and the
 * time (migration 035). The first ban stands: banning a banned account keeps
 * its source, so the extension that placed it can still lift it with
 * `liftOwnBan` and a second one cannot. `active = true` lifts ANY ban, whoever
 * placed it — what auth/scim ≤ 1.0.15 relies on; new code lifts with
 * `liftOwnBan`.
 */
export async function setUserActive(
  callerDb: Database,
  poolDb: Database,
  userId: string,
  active: boolean,
  source: string,
): Promise<void> {
  const db = engineHandle(callerDb); // engine SQL — see deleteUser
  if (!active) await refuseGod(db, userId, 'deactivated');
  // IdPs resend `active: true` on every sync; only a change touches the row.
  // The provenance columns follow `banned` through the trigger of migration 035.
  await sql`
    UPDATE "user" SET banned = ${!active}, ban_source = ${active ? null : source},
                      "updatedAt" = NOW()
     WHERE id = ${userId} AND COALESCE(banned, false) <> ${!active}
  `.execute(db);
  if (!active) await revokeThroughCommit(poolDb, userId);
}

/**
 * Lift `userId`'s ban only if `source` placed it; whether it did. A ban an
 * administrator or another extension placed — or one older than migration
 * 035 (`unknown`) — stays. Nothing to revoke: lifting opens, it does not close.
 */
export async function liftOwnBan(
  callerDb: Database,
  userId: string,
  source: string,
): Promise<boolean> {
  const db = engineHandle(callerDb); // engine SQL — see deleteUser
  const r = await sql`
    UPDATE "user" SET banned = false, "updatedAt" = NOW()
     WHERE id = ${userId} AND banned IS TRUE AND ban_source = ${source}
    RETURNING id
  `.execute(db);
  return r.rows.length > 0;
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
  callerDb: Database,
  poolDb: Database,
  userId: string,
  opts: CreateSsoSessionOptions = {},
): Promise<{ token: string; setCookie: string }> {
  const db = engineHandle(callerDb); // engine SQL — see deleteUser
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
