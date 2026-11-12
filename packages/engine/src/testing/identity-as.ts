/**
 * The engine's identity helpers (`lib/identity.ts`, `lib/users.ts`) bound to an
 * actor, in the shape `ctx.internals` offered them until ADR 0039 decision 9.
 * Extensions reach directory provisioning through `host.identity` now; these
 * helpers are what it is built from, and their tests call them here.
 */

import { type Database, getDb } from '../db/index.js';
import {
  addTenantMember,
  listTenantUsers,
  provisionUser,
  removeTenantMember,
  setTenantMembershipEnd,
  updateUserProfile,
} from '../lib/identity.js';
import { liftOwnBan, revokeUserSessions, setUserActive } from '../lib/users.js';

export function identityAs(actor: string) {
  return {
    provisionUser: (input: { email: string; name?: string }) => provisionUser(input, actor),
    listTenantUsers: (
      db: unknown,
      q?: { email?: string; userId?: string; limit?: number; offset?: number },
    ) => listTenantUsers(db as Database, q),
    updateUserProfile: (db: unknown, userId: string, patch: { name?: string; email?: string }) =>
      updateUserProfile(db as Database, userId, patch, actor),
    addTenantMember: (db: unknown, userId: string, role = 'member') =>
      addTenantMember(db as Database, userId, role, actor),
    removeTenantMember: (db: unknown, userId: string) =>
      removeTenantMember(db as Database, userId, actor),
    setTenantMembershipEnd: (
      db: unknown,
      userId: string,
      validTo: string | null,
      guard?: { ifInForce?: boolean; ifValidTo?: string | null },
    ) => setTenantMembershipEnd(db as Database, userId, validTo, guard, actor),
    setUserActive: (db: unknown, userId: string, active: boolean) =>
      setUserActive(db as Database, getDb(), userId, active, actor),
    liftOwnBan: (db: unknown, userId: string) => liftOwnBan(db as Database, userId, actor),
    revokeUserSessions: (userId: string) => revokeUserSessions(getDb(), userId),
  };
}
