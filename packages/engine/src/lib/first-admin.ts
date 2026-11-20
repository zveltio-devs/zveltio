/**
 * The instance's first administrator (ADR 0056 d4).
 *
 * `create-god` used to write the `user` and `account` rows by hand: its own
 * argon2 call, its own copy of the `issuer` better-auth 1.7 looks for, no
 * password policy, no record. Every drift between that copy and better-auth
 * (the 1.7 `issuer` was one) made an admin that could not sign in. The account
 * is now made by `auth.api.signUpEmail`, as an invitation makes one, so the
 * hash, the account row and the length policy are better-auth's; the engine
 * only promotes it.
 *
 * One god per instance. A second call is refused while one exists: taking the
 * role over is recovery (`/api/permissions/bootstrap`), which promotes an
 * existing account and never creates one.
 */

import { sql } from 'kysely';
import type { Database } from '../db/index.js';
import { auditLog } from './audit.js';
import { getAuth, revokeAllUserSessions, withAuthorizedUserCreation } from './auth.js';

/** Refused before anything was written; the message is for the operator. */
export class FirstAdminRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirstAdminRefusedError';
  }
}

/**
 * Create the god account through better-auth. Needs `initAuth` first.
 * Throws `FirstAdminRefusedError` when the instance already has a god, and
 * better-auth's `APIError` for a refused email or password (too short, too long,
 * already taken).
 */
export async function createFirstAdmin(
  db: Database,
  input: { email: string; password: string; name?: string },
): Promise<{ id: string; email: string }> {
  let createdId: string | undefined;
  try {
    return await db.transaction().execute(async (trx) => {
      // Two concurrent calls queue here; the second then sees the first's god.
      await sql`SELECT pg_advisory_xact_lock(hashtext('zveltio:first-admin'))`.execute(trx);
      const god = await trx
        .selectFrom('user')
        .select('email')
        .where('role', '=', 'god')
        .executeTakeFirst();
      if (god) {
        throw new FirstAdminRefusedError(
          `This instance already has its administrator (${god.email}). ` +
            'To hand the role to another account, use the recovery procedure (RECOVERY_TOKEN).',
        );
      }
      // On better-auth's own pool, committed on its own: the lock above is what
      // keeps a second caller out until this transaction ends.
      const res = await withAuthorizedUserCreation<{ user?: { id: string } }>(() =>
        getAuth().api.signUpEmail({
          body: {
            email: input.email,
            password: input.password,
            name: input.name || input.email.split('@')[0],
          },
        }),
      );
      createdId = res?.user?.id;
      if (!createdId) throw new Error('better-auth created no user');
      const user = await trx
        .updateTable('user')
        .set({ role: 'god', emailVerified: true, updatedAt: new Date() })
        .where('id', '=', createdId)
        .returning(['id', 'email'])
        .executeTakeFirstOrThrow();
      // Sign-up signed the new account in; that session went to nobody.
      await revokeAllUserSessions(trx, user.id);
      await auditLog(trx, {
        type: 'user.created',
        userId: user.id,
        resourceId: user.id,
        resourceType: 'user',
        metadata: { reason: 'first_admin', role: 'god' },
      });
      return user;
    });
  } catch (err) {
    // The account committed with better-auth but the promotion did not: take it
    // back, or a retry meets "already exists" for an account that is no admin.
    if (createdId) {
      await db
        .deleteFrom('user')
        .where('id', '=', createdId)
        .execute()
        .catch((e: Error) => {
          console.error(`[first-admin] could not remove ${createdId}:`, e.message);
        });
    }
    throw err;
  }
}
