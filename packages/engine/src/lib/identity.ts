/**
 * Identity provisioning: the engine is the only writer of `"user"`,
 * `zv_tenant_users` and `zv_tenants`.
 *
 * auth/scim, auth/ldap and auth/saml wrote those tables with raw SQL on
 * `ctx.db`. Since raw SQL from an extension meets its table allowlist (#858)
 * every one of those statements is refused — SSO sign-in and SCIM provisioning
 * stopped working — and granting the tables back would hand three extensions
 * every account on the instance. They get these operations instead, gated
 * `identity:provision` (see `ctx.internals` in internals.ts):
 *
 *   - a user is created through better-auth, never as `god` and never with a
 *     password;
 *   - membership changes only in the tenant the work RUNS as (entering another
 *     needs `tenant:enter`), and only up to `member`/`viewer`;
 *   - a profile is changed only for a user the running tenant alone holds — not
 *     god, not an instance admin, no membership or grant anywhere else — so one
 *     tenant's IdP cannot rename, or re-address the password reset of, somebody
 *     another tenant or the instance depends on.
 */

import { type RawBuilder, sql } from 'kysely';
import { getDb } from '../db/index.js';
import type { Database } from '../db/index.js';
import { auditLog } from './audit.js';
import { getAuth, withAuthorizedUserCreation } from './auth.js';
import { engineHandle } from './engine-handle.js';
import {
  activeMembership,
  DEFAULT_TENANT_ID,
  getCurrentDomainOrNull,
  getEnforcer,
  invalidateTenantCache,
  invalidateUserPermCache,
  requireInstanceAdmin,
} from './tenancy/index.js';

/** Membership grades (`zv_tenant_users.role`, a CHECK constraint). */
export const TENANT_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];
/** The Casbin role a grade grants, in the tenant's domain. */
export const casbinTenantRole = (r: string) => `tenant_${r}`;
/** What an extension may grant: `admin` in the default tenant IS instance admin. */
const EXTENSION_ROLES: ReadonlySet<string> = new Set(['member', 'viewer']);

export type IdentityRefusal =
  | 'no_tenant'
  | 'no_such_user'
  | 'user_not_owned'
  | 'role_not_allowed'
  | 'email_taken'
  | 'invalid_input';

/** A refusal an extension can match on `code` and answer its caller with. */
export class IdentityRefusedError extends Error {
  constructor(
    readonly code: IdentityRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'IdentityRefusedError';
  }
}

export interface IdentityUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** ISO-8601, microseconds — Postgres' own precision, so a value read here compares equal. */
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembership {
  role: TenantRole;
  validFrom: string;
  validTo: string | null;
  inForce: boolean;
}

/** `membership` is null on a single-tenant instance: everyone belongs, in force. */
export interface IdentityMember extends IdentityUser {
  membership: TenantMembership | null;
}

const iso = (col: RawBuilder<unknown>) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const USER_COLUMNS = sql`u.id, u.email, u.name, COALESCE(u."emailVerified", false) AS "emailVerified",
  ${iso(sql`u."createdAt"`)} AS "createdAt", ${iso(sql`u."updatedAt"`)} AS "updatedAt"`;

function runningTenant(member: string): string {
  const tenant = getCurrentDomainOrNull();
  if (tenant) return tenant;
  throw new IdentityRefusedError(
    'no_tenant',
    `ctx.internals.${member}: no tenant runs here. Membership is changed in the tenant the ` +
      'request or job runs as; enter one with ctx.internals.withTenantIsolation (outside a ' +
      'request that needs the "tenant:enter" capability).',
  );
}

/** At most one tenant exists, so every user belongs to it. */
export async function isSingleTenantInstance(db: Database = getDb()): Promise<boolean> {
  const r = await sql<{ solo: boolean }>`
    SELECT COUNT(*) <= 1 AS solo FROM zv_tenants`.execute(engineHandle(db));
  return r.rows[0]?.solo === true;
}

async function userByEmail(db: Database, email: string): Promise<IdentityUser | null> {
  const r = await sql<IdentityUser>`
    SELECT ${USER_COLUMNS} FROM "user" u WHERE lower(u.email) = ${email}`.execute(db);
  return r.rows[0] ?? null;
}

function normalEmail(email: unknown): string {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) {
    throw new IdentityRefusedError('invalid_input', `Not an email address: ${String(email)}`);
  }
  return e;
}

/**
 * The account for `email`, created when there is none: through better-auth (its
 * hooks, its id), verified, passwordless, at the column-default role — never
 * god. Allowed while self-registration is off: the administrator who approved
 * the capability authorised it. The account lands in no tenant.
 */
export async function provisionUser(
  input: { email: string; name?: string },
  actor: string,
): Promise<{ user: IdentityUser; created: boolean }> {
  const email = normalEmail(input.email);
  const db = getDb();
  const existing = await userByEmail(db, email);
  if (existing) return { user: existing, created: false };
  const name = input.name?.trim() || email.split('@')[0]!;
  const ctx = await getAuth().$context;
  try {
    await withAuthorizedUserCreation(() =>
      ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: 'admin' }),
    );
  } catch (err) {
    // A concurrent provision of the same email won the unique index.
    const raced = await userByEmail(db, email);
    if (raced) return { user: raced, created: false };
    throw err;
  }
  const user = await userByEmail(db, email);
  if (!user) throw new Error(`provisionUser: ${email} vanished after it was created`);
  await auditLog(db, {
    type: 'user.created',
    resourceId: user.id,
    resourceType: 'user',
    metadata: { actor, reason: 'identity.provision', email },
  });
  return { user, created: true };
}

/**
 * Users of the running tenant: a membership row there, lapsed included (still
 * the tenant's to read and deprovision) — or every user on a single-tenant
 * instance. Ordered by creation; `limit` at most 1000.
 */
export async function listTenantUsers(
  callerDb: Database,
  q: { email?: string; userId?: string; limit?: number; offset?: number } = {},
): Promise<IdentityMember[]> {
  const tenant = runningTenant('listTenantUsers');
  const db = engineHandle(callerDb);
  const everyone = tenant === DEFAULT_TENANT_ID && (await isSingleTenantInstance(db));
  const limit = Math.min(1000, Math.max(0, Math.trunc(q.limit ?? 100)));
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));
  const r = await sql<
    IdentityUser & {
      role: TenantRole | null;
      valid_from: string | null;
      valid_to: string | null;
      in_force: boolean | null;
    }
  >`
    SELECT ${USER_COLUMNS}, tu.role, ${iso(sql`tu.valid_from`)} AS valid_from,
           ${iso(sql`tu.valid_to`)} AS valid_to, ${activeMembership('tu')} AS in_force
      FROM "user" u
      LEFT JOIN zv_tenant_users tu ON tu.user_id = u.id AND tu.tenant_id = ${tenant}::uuid
     WHERE (${everyone} OR tu.user_id IS NOT NULL)
       AND (${q.email ?? null}::text IS NULL OR lower(u.email) = lower(${q.email ?? null}::text))
       AND (${q.userId ?? null}::text IS NULL OR u.id = ${q.userId ?? null}::text)
     ORDER BY u."createdAt", u.id
     LIMIT ${limit} OFFSET ${offset}`.execute(db);
  return r.rows.map(({ role, valid_from, valid_to, in_force, ...user }) => ({
    ...user,
    membership: role
      ? { role, validFrom: valid_from!, validTo: valid_to, inForce: in_force === true }
      : null,
  }));
}

/**
 * Why `userId` is not the running tenant's alone, or null when it is. Locks the
 * row, so the answer holds until the caller's transaction ends.
 */
async function notOwnedBy(
  db: Database,
  userId: string,
  tenant: string,
): Promise<'missing' | 'god' | 'instance_admin' | 'other_tenant' | 'other_grants' | null> {
  const r = await sql<{ role: string | null }>`
    SELECT role FROM "user" WHERE id = ${userId} FOR UPDATE`.execute(db);
  if (!r.rows[0]) return 'missing';
  if (r.rows[0].role === 'god') return 'god';
  if (tenant === DEFAULT_TENANT_ID && (await requireInstanceAdmin(userId))) {
    return 'instance_admin';
  }
  if (await isSingleTenantInstance(db)) return null;
  const elsewhere = await sql`
    SELECT 1 FROM zv_tenant_users
     WHERE user_id = ${userId} AND tenant_id <> ${tenant}::uuid LIMIT 1`.execute(db);
  if (elsewhere.rows.length) return 'other_tenant';
  // A grant in '*' or another domain is power the instance gave, not this tenant.
  const e = await getEnforcer();
  const roles = (await e.getFilteredGroupingPolicy(0, userId)).filter((g) => g[2] !== tenant);
  const rules = (await e.getFilteredPolicy(0, userId)).filter((p) => p[1] !== tenant);
  return roles.length || rules.length ? 'other_grants' : null;
}

/**
 * Change the name and/or email of a user the running tenant alone holds. An
 * email another account has is refused, case-insensitively.
 */
export async function updateUserProfile(
  callerDb: Database,
  userId: string,
  patch: { name?: string; email?: string },
  actor: string,
): Promise<IdentityUser> {
  const tenant = runningTenant('updateUserProfile');
  const db = engineHandle(callerDb);
  const email = patch.email === undefined ? null : normalEmail(patch.email);
  const name = patch.name === undefined ? null : String(patch.name).trim();
  if (name === '') throw new IdentityRefusedError('invalid_input', 'A name cannot be empty.');

  const why = await notOwnedBy(db, userId, tenant);
  if (why === 'missing') throw new IdentityRefusedError('no_such_user', `No user ${userId}.`);
  if (why) {
    throw new IdentityRefusedError(
      'user_not_owned',
      `User ${userId} is not this tenant's alone (${why}); their profile is changed by an ` +
        'instance administrator.',
    );
  }
  // One statement: the uniqueness probe cannot be failed by a 23505 that would
  // abort the caller's transaction. ponytail: a concurrent INSERT of the same
  // email can still reach the unique index between the probe and the write.
  const r = await sql<IdentityUser>`
    UPDATE "user" u SET name = COALESCE(${name}, u.name), email = COALESCE(${email}, u.email),
                        "updatedAt" = now()
     WHERE u.id = ${userId}
       AND (${email}::text IS NULL OR NOT EXISTS (
             SELECT 1 FROM "user" o WHERE lower(o.email) = ${email} AND o.id <> ${userId}))
    RETURNING ${USER_COLUMNS}`.execute(db);
  const user = r.rows[0];
  if (!user) throw new IdentityRefusedError('email_taken', `${email} belongs to another account.`);
  await auditLog(db, {
    type: 'user.profile_updated',
    resourceId: userId,
    resourceType: 'user',
    metadata: { actor, tenant_id: tenant, fields: Object.keys(patch) },
  });
  return user;
}

async function tenantSlug(db: Database, tenantId: string): Promise<string | null> {
  const r = await sql<{ slug: string }>`
    SELECT slug FROM zv_tenants WHERE id = ${tenantId}::uuid`.execute(db);
  return r.rows[0]?.slug ?? null;
}

/**
 * Upsert `userId`'s membership of `tenantId` at `role`, and make the Casbin
 * grant in the tenant's domain match. `reopen` also puts a lapsed or future
 * membership in force from now — what an administrator adding someone means.
 * Not audited: the caller records who asked.
 */
export async function grantTenantMembership(
  db: Database,
  tenant: { id: string; slug: string | null },
  userId: string,
  role: TenantRole,
  opts: { invitedBy?: string | null; reopen: boolean },
): Promise<void> {
  await sql`
    INSERT INTO zv_tenant_users (tenant_id, user_id, role, invited_by)
    VALUES (${tenant.id}, ${userId}, ${role}, ${opts.invitedBy ?? null})
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role
      ${opts.reopen ? sql`, valid_from = LEAST(zv_tenant_users.valid_from, now()), valid_to = NULL` : sql``}
  `.execute(db);
  const e = await getEnforcer();
  for (const r of TENANT_ROLES) await e.deleteRoleForUser(userId, casbinTenantRole(r), tenant.id);
  await e.addRoleForUser(userId, casbinTenantRole(role), tenant.id);
  await invalidateUserPermCache(userId);
  if (tenant.slug) await invalidateTenantCache(tenant.slug, tenant.id, userId);
}

/**
 * Remove `userId` from `tenantId` with every role they hold in its domain — an
 * invited `manager` or custom role too (migration 034's trigger does the same
 * on the table; this updates the live model). Whether a row went.
 */
export async function revokeTenantMembership(
  db: Database,
  tenant: { id: string; slug: string | null },
  userId: string,
): Promise<boolean> {
  const r = await sql`
    DELETE FROM zv_tenant_users WHERE tenant_id = ${tenant.id} AND user_id = ${userId}
    RETURNING id`.execute(db);
  const e = await getEnforcer();
  await e.deleteRolesForUser(userId, tenant.id);
  await invalidateUserPermCache(userId);
  if (tenant.slug) await invalidateTenantCache(tenant.slug, tenant.id, userId);
  return r.rows.length > 0;
}

async function currentMembership(db: Database, tenant: string, userId: string) {
  const r = await sql<{ role: TenantRole; valid_to: string | null }>`
    SELECT role, ${iso(sql`valid_to`)} AS valid_to FROM zv_tenant_users
     WHERE tenant_id = ${tenant}::uuid AND user_id = ${userId} FOR UPDATE`.execute(db);
  return r.rows[0] ?? null;
}

async function inForceAnywhere(db: Database, userId: string): Promise<boolean> {
  const r = await sql<{ any: boolean }>`
    SELECT EXISTS (SELECT 1 FROM zv_tenant_users tu
                    WHERE tu.user_id = ${userId} AND ${activeMembership('tu')}) AS any`.execute(db);
  return r.rows[0]?.any === true;
}

/**
 * Make `userId` a `member` or `viewer` of the running tenant, or move them
 * between the two. Dates stay: a membership the business ended is not reopened
 * by provisioning. An `owner` or `admin` is a tenant administrator's to change.
 */
export async function addTenantMember(
  callerDb: Database,
  userId: string,
  role: string,
  actor: string,
): Promise<'added' | 'role_changed' | 'unchanged'> {
  const tenant = runningTenant('addTenantMember');
  if (!EXTENSION_ROLES.has(role)) {
    throw new IdentityRefusedError(
      'role_not_allowed',
      `An extension grants "member" or "viewer", not "${role}".`,
    );
  }
  const db = engineHandle(callerDb);
  const user = await sql`SELECT 1 FROM "user" WHERE id = ${userId} FOR KEY SHARE`.execute(db);
  if (!user.rows.length) throw new IdentityRefusedError('no_such_user', `No user ${userId}.`);
  const had = await currentMembership(db, tenant, userId);
  if (had && !EXTENSION_ROLES.has(had.role)) {
    throw new IdentityRefusedError(
      'role_not_allowed',
      `User ${userId} is "${had.role}" of this tenant; a tenant administrator changes that.`,
    );
  }
  await grantTenantMembership(
    db,
    { id: tenant, slug: await tenantSlug(db, tenant) },
    userId,
    role as TenantRole,
    { reopen: false },
  );
  await auditLog(db, {
    type: 'tenant.member_added',
    tenantId: tenant,
    resourceId: userId,
    resourceType: 'tenant_member',
    metadata: { actor, tenant_id: tenant, role, previous_role: had?.role ?? null },
  });
  if (!had) return 'added';
  return had.role === role ? 'unchanged' : 'role_changed';
}

/**
 * Remove `userId` from the running tenant. `orphaned`: no tenant holds the
 * account any more and nothing else does (god, instance admin, a grant
 * elsewhere) — deleting it (`deleteUser`, `auth:users`) is then the caller's
 * call. Never true for a user this tenant did not have. `inForceAnywhere`: a
 * membership in force remains somewhere, so a session still opens something.
 */
export async function removeTenantMember(
  callerDb: Database,
  userId: string,
  actor: string,
): Promise<{ removed: boolean; orphaned: boolean; inForceAnywhere: boolean }> {
  const tenant = runningTenant('removeTenantMember');
  const db = engineHandle(callerDb);
  // Locked first: two tenants removing the same person serialize here, so the
  // second sees the first's removal and one of them finds the account orphaned.
  const user = await sql`SELECT 1 FROM "user" WHERE id = ${userId} FOR UPDATE`.execute(db);
  if (!user.rows.length) return { removed: false, orphaned: false, inForceAnywhere: false };
  const removed = await revokeTenantMembership(
    db,
    { id: tenant, slug: await tenantSlug(db, tenant) },
    userId,
  );
  if (removed) {
    await auditLog(db, {
      type: 'tenant.member_removed',
      tenantId: tenant,
      resourceId: userId,
      resourceType: 'tenant_member',
      metadata: { actor, tenant_id: tenant },
    });
  }
  // Every row, lapsed ones too: another tenant's expired membership is its
  // history, and deleting the account would cascade it away.
  const left = await sql`SELECT 1 FROM zv_tenant_users WHERE user_id = ${userId} LIMIT 1`.execute(
    db,
  );
  const hadIt = removed || (tenant === DEFAULT_TENANT_ID && (await isSingleTenantInstance(db)));
  const orphaned = hadIt && !left.rows.length && (await notOwnedBy(db, userId, tenant)) === null;
  return { removed, orphaned, inForceAnywhere: await inForceAnywhere(db, userId) };
}

/**
 * Set when `userId`'s membership of the running tenant ends: `'now'`, an
 * ISO-8601 instant, or null (open-ended). `ifInForce` changes only a membership
 * in force; `ifValidTo` only one whose end is still exactly that value (as this
 * API returned it) — a date somebody else wrote since wins. Null when the user
 * is no member here.
 */
export async function setTenantMembershipEnd(
  callerDb: Database,
  userId: string,
  validTo: string | null,
  guard: { ifInForce?: boolean; ifValidTo?: string | null } = {},
  actor = 'engine',
): Promise<{
  changed: boolean;
  previousValidTo: string | null;
  validTo: string | null;
  inForceAnywhere: boolean;
} | null> {
  const tenant = runningTenant('setTenantMembershipEnd');
  for (const v of [validTo, guard.ifValidTo]) {
    if (typeof v === 'string' && v !== 'now' && Number.isNaN(Date.parse(v))) {
      throw new IdentityRefusedError('invalid_input', `Not an instant: ${v}`);
    }
  }
  if (guard.ifValidTo === 'now') {
    throw new IdentityRefusedError('invalid_input', 'ifValidTo takes an instant, not "now".');
  }
  const db = engineHandle(callerDb);
  const had = await currentMembership(db, tenant, userId);
  if (!had) return null;
  const end = validTo === 'now' ? sql`now()` : sql`${validTo}::timestamptz`;
  const r = await sql<{ valid_to: string | null }>`
    UPDATE zv_tenant_users tu SET valid_to = ${end}
     WHERE tu.tenant_id = ${tenant}::uuid AND tu.user_id = ${userId}
       AND (${guard.ifInForce === true} IS FALSE OR ${activeMembership('tu')})
       AND (${'ifValidTo' in guard} IS FALSE
            OR tu.valid_to IS NOT DISTINCT FROM ${guard.ifValidTo ?? null}::timestamptz)
    RETURNING ${iso(sql`tu.valid_to`)} AS valid_to`.execute(db);
  const changed = r.rows.length > 0;
  if (changed) {
    const slug = await tenantSlug(db, tenant);
    if (slug) await invalidateTenantCache(slug, tenant, userId);
    await auditLog(db, {
      type: 'tenant.member_updated',
      tenantId: tenant,
      resourceId: userId,
      resourceType: 'tenant_member',
      metadata: { actor, tenant_id: tenant, valid_to: r.rows[0]!.valid_to, previous: had.valid_to },
    });
  }
  return {
    changed,
    previousValidTo: had.valid_to,
    validTo: changed ? r.rows[0]!.valid_to : had.valid_to,
    inForceAnywhere: await inForceAnywhere(db, userId),
  };
}
