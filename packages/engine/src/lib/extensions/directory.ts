/**
 * ADR 0039 decision 9: directory provisioning is a narrow engine contract.
 *
 * A foreign system that manages people (an identity provider speaking SCIM)
 * reaches the engine's accounts through five operations on `host.identity`,
 * under the capability `identity:provision`. The provider is the extension; it
 * names each account by its own id for it (`subject`). The rules are the
 * engine's:
 *
 *   - a provider reaches only the accounts it provisioned, in the tenant the
 *     request runs in (`zv_identity_links`, migration 120) — not another
 *     provider's, not another tenant's, not an account it did not create;
 *   - each operation is a whole act, in one savepoint of the request's
 *     transaction: a refusal half-way leaves nothing behind;
 *   - an existing account is never claimed by naming its e-mail
 *     (`account_exists`);
 *   - the engine writes the audit entry, with the provider as the actor.
 *
 * `auth/scim` called ten `ctx.internals` members for the same work and held
 * `auth:users` ("remove anyone"); those are gone from what extensions are
 * offered (capability contract 11).
 */

import type { Context } from 'hono';
import { type RawBuilder, sql } from 'kysely';
import type { DirectoryAccount, DirectoryProvisionInput } from '@zveltio/sdk/extension';
import { type Database, getDb } from '../../db/index.js';
import { publicRouteRequest } from '../../middleware/extension-auth-gate.js';
import { auditLog } from '../audit.js';
import {
  addTenantMember,
  IdentityRefusedError,
  isSingleTenantInstance,
  provisionUser,
  removeTenantMember,
  setTenantMembershipEnd,
  updateUserProfile,
} from '../identity.js';
import { problem } from '../problem.js';
import { asEngineRole } from '../role-window.js';
import { withSavepoint } from '../savepoint.js';
import {
  activeMembership,
  DEFAULT_TENANT_ID,
  getCurrentDomainOrNull,
  getCurrentTenantTrx,
} from '../tenancy/index.js';
import {
  deleteUser,
  liftOwnBan,
  ProtectedUserError,
  revokeThroughCommit,
  setUserActive,
} from '../users.js';
import { holdsCapability } from './capabilities.js';

/** The `host.identity` members of decision 9. */
export interface RouteDirectory {
  provision(input: DirectoryProvisionInput): Promise<DirectoryAccount>;
  update(subject: string, patch: { email?: string; name?: string }): Promise<DirectoryAccount>;
  setActive(subject: string, active: boolean): Promise<DirectoryAccount>;
  remove(subject: string): Promise<void>;
  list(query?: { email?: string; limit?: number; offset?: number }): Promise<DirectoryAccount[]>;
  get(subject: string): Promise<DirectoryAccount | null>;
}

/** The HTTP status each refusal answers with. */
const STATUS: Record<string, number> = {
  no_such_user: 404,
  account_exists: 409,
  email_taken: 409,
  invalid_input: 400,
  user_not_owned: 403,
  role_not_allowed: 403,
  not_in_force: 403,
  user_protected: 403,
};

const iso = (col: RawBuilder<unknown>) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface LinkRow {
  subject: string;
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  flag: boolean;
  suspended_at: string | null;
  held_valid_to: string | null;
  /** A membership row here. */
  member: boolean;
  in_force: boolean;
  /** The membership's end is still the one this provider's `setActive(false)` wrote. */
  own_suspension: boolean;
}

function subjectOf(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 1024 || v.includes('\0')) {
    throw new IdentityRefusedError('invalid_input', 'A subject is a non-empty string of at most 1024 characters.');
  }
  return v;
}

/**
 * A declared route's directory operations. Each call refuses unless the route
 * is declared `public` and the `/ext/*` gate admitted this request as this
 * extension's public route (else it throws: the extension's bug, 500), and the
 * extension holds an approved `identity:provision` (else 403
 * `capability_required`). A refusal by the engine's rules throws a problem
 * whose `code` names it, with `status` set.
 */
export function routeDirectory(c: Context, extName: string, access: string): RouteDirectory {
  const actor = `ext:${extName}`;

  /** Run `op` as one act in the request's transaction and tenant. */
  async function act<T>(name: string, op: (trx: Database, tenant: string) => Promise<T>): Promise<T> {
    if (access !== 'public' || publicRouteRequest(c)?.extName !== extName) {
      throw new Error(`${extName}: host.identity answers only on a declared public route`);
    }
    if (!holdsCapability(extName, 'identity:provision')) {
      throw problem(
        'capability_required',
        403,
        `host.identity.${name}: "${extName}" does not hold the "identity:provision" capability ` +
          '(declared in its manifest and approved by an administrator)',
      );
    }
    const trx = getCurrentTenantTrx();
    const tenant = getCurrentDomainOrNull();
    if (!trx || !tenant) throw new Error(`${extName}: host.identity.${name} runs only inside a request`);
    try {
      return await withSavepoint(trx, `zv_directory_${name}`, () => op(trx, tenant), (err) => {
        throw err;
      });
    } catch (err) {
      const code =
        err instanceof IdentityRefusedError || err instanceof ProtectedUserError ? err.code : null;
      if (code && STATUS[code]) throw problem(code, STATUS[code]!, (err as Error).message);
      throw err;
    }
  }

  const solo = async (db: Database, tenant: string) =>
    tenant === DEFAULT_TENANT_ID && (await isSingleTenantInstance(db));

  /** This provider's links in `tenant`, with the account and its membership here. */
  async function links(
    db: Database,
    tenant: string,
    q: { subject?: string; email?: string; limit?: number; offset?: number; lock?: boolean },
  ): Promise<LinkRow[]> {
    const everyone = await solo(db, tenant);
    for (const v of [q.limit, q.offset]) {
      if (v !== undefined && !Number.isSafeInteger(Math.trunc(v))) {
        throw new IdentityRefusedError('invalid_input', `Not a number: ${String(v)}`);
      }
    }
    const limit = Math.min(1000, Math.max(0, Math.trunc(q.limit ?? 100)));
    const offset = Math.max(0, Math.trunc(q.offset ?? 0));
    // A link whose membership here an administrator removed is no longer the
    // tenant's account: not listed, not reached (the link stays, inert).
    const r = await asEngineRole(db, () =>
      sql<LinkRow>`
        SELECT l.subject, u.id, u.email, u.name,
               ${iso(sql`u."createdAt"`)} AS "createdAt", ${iso(sql`u."updatedAt"`)} AS "updatedAt",
               l.active AS flag, ${iso(sql`l.suspended_at`)} AS suspended_at,
               ${iso(sql`l.held_valid_to`)} AS held_valid_to,
               tu.user_id IS NOT NULL AS member,
               COALESCE(${activeMembership('tu')}, false) AS in_force,
               COALESCE(tu.valid_from <= now() AND tu.valid_to IS NOT NULL
                        AND tu.valid_to = l.suspended_at, false) AS own_suspension
          FROM zv_identity_links l
          JOIN "user" u ON u.id = l.user_id
          LEFT JOIN zv_tenant_users tu ON tu.user_id = l.user_id AND tu.tenant_id = l.tenant_id
         WHERE l.tenant_id = ${tenant}::uuid AND l.provider = ${extName}
           AND (${everyone} OR tu.user_id IS NOT NULL)
           AND (${q.subject ?? null}::text IS NULL OR l.subject = ${q.subject ?? null}::text)
           AND (${q.email ?? null}::text IS NULL OR lower(u.email) = lower(${q.email ?? null}::text))
         ORDER BY l.created_at, l.subject
         LIMIT ${limit} OFFSET ${offset}
         ${q.lock ? sql`FOR UPDATE OF l` : sql``}`.execute(db),
    );
    return r.rows;
  }

  /** What the provider is told: its flag AND a membership in force here. */
  const account = (row: LinkRow, everyone: boolean): DirectoryAccount => ({
    subject: row.subject,
    id: row.id,
    email: row.email,
    name: row.name,
    active: row.flag && (everyone || row.in_force),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  async function read(db: Database, tenant: string, subject: string): Promise<DirectoryAccount> {
    const row = (await links(db, tenant, { subject, limit: 1 }))[0];
    if (!row) throw new IdentityRefusedError('no_such_user', 'No such account.');
    return account(row, await solo(db, tenant));
  }

  /** The linked account, locked; `no_such_user` when this provider has none here. */
  async function linked(db: Database, tenant: string, subject: string): Promise<LinkRow> {
    const row = (await links(db, tenant, { subject: subjectOf(subject), limit: 1, lock: true }))[0];
    // 404 whether the account exists for another provider or tenant: that is
    // not this caller's to learn.
    if (!row) throw new IdentityRefusedError('no_such_user', 'No such account.');
    return row;
  }

  /**
   * A membership here the business ended (or has not started) is read and
   * removed, not changed: that date wins over the provider. Except the
   * provider's own suspension, which is its to lift. A single-tenant instance
   * has no membership to lapse.
   */
  async function refuseLapsed(db: Database, tenant: string, row: LinkRow): Promise<void> {
    if (!row.member || row.in_force || row.own_suspension || (await solo(db, tenant))) return;
    throw new IdentityRefusedError(
      'not_in_force',
      "The account's membership in this tenant is not in force (ended or not yet started): " +
        'it can be read or removed, not changed.',
    );
  }

  const audit = (
    db: Database,
    type: 'identity.provisioned' | 'identity.updated' | 'identity.active_set' | 'identity.removed',
    tenant: string,
    userId: string,
    subject: string,
    metadata: Record<string, unknown> = {},
  ) =>
    auditLog(db, {
      type,
      tenantId: tenant,
      resourceId: userId,
      resourceType: 'user',
      metadata: { actor, provider: extName, subject, tenant_id: tenant, ...metadata },
    });

  /**
   * Record the provider's flag and enforce it. Single-tenant: `false` blocks
   * sign-in by every method and ends the sessions; `true` lifts the block only
   * if this provider placed it. Multi-tenant: sign-in is instance-wide but the
   * provider speaks for one tenant, so `false` ends the membership here (once:
   * a resend keeps the end it holds) and blocks sign-in only when no tenant is
   * left in force; `true` puts back the end the business had set, only while
   * the membership still carries the provider's own end, and lifts its block
   * once a tenant is in force again.
   */
  async function enforce(db: Database, tenant: string, row: LinkRow, active: boolean) {
    const userId = row.id;
    await asEngineRole(db, () =>
      sql`UPDATE zv_identity_links SET active = ${active}, updated_at = now()
           WHERE tenant_id = ${tenant}::uuid AND provider = ${extName} AND subject = ${row.subject}`.execute(
        db,
      ),
    );
    if (await solo(db, tenant)) {
      if (active) await liftOwnBan(db, userId, actor);
      else await setUserActive(db, getDb(), userId, false, actor);
      return;
    }
    if (active) {
      let inForce = row.in_force;
      if (row.suspended_at) {
        const back = await setTenantMembershipEnd(
          db,
          userId,
          row.held_valid_to,
          { ifValidTo: row.suspended_at },
          actor,
        );
        await asEngineRole(db, () =>
          sql`UPDATE zv_identity_links SET suspended_at = NULL, held_valid_to = NULL
               WHERE tenant_id = ${tenant}::uuid AND provider = ${extName}
                 AND subject = ${row.subject}`.execute(db),
        );
        inForce = back?.inForceAnywhere ?? inForce;
      }
      if (inForce) await liftOwnBan(db, userId, actor);
      return;
    }
    const ended = await setTenantMembershipEnd(db, userId, 'now', { ifInForce: true }, actor);
    if (ended?.changed) {
      await asEngineRole(db, () =>
        sql`UPDATE zv_identity_links SET suspended_at = ${ended.validTo}::timestamptz,
                                         held_valid_to = ${ended.previousValidTo}::timestamptz
             WHERE tenant_id = ${tenant}::uuid AND provider = ${extName}
               AND subject = ${row.subject}`.execute(db),
      );
    }
    if (ended?.inForceAnywhere) return;
    // A block already there keeps its source: the engine records the first.
    await setUserActive(db, getDb(), userId, false, actor);
  }

  return {
    provision: (input) =>
      act('provision', async (db, tenant) => {
        const subject = subjectOf(input?.subject);
        const active = input?.active !== false;
        const taken = await asEngineRole(db, () =>
          sql`SELECT 1 FROM zv_identity_links
               WHERE tenant_id = ${tenant}::uuid AND provider = ${extName}
                 AND subject = ${subject}`.execute(db),
        );
        if (taken.rows.length) {
          throw new IdentityRefusedError('account_exists', 'This subject is already provisioned.');
        }
        // A new account only: one that exists, whoever holds it, is a conflict
        // an administrator resolves (an invitation proves control of the address).
        const { user, created } = await provisionUser(
          { email: input.email, ...(typeof input.name === 'string' ? { name: input.name } : {}) },
          actor,
        );
        if (!created) {
          throw new IdentityRefusedError(
            'account_exists',
            'An account with this e-mail exists; a provider provisions new accounts only. An ' +
              "existing account joins a tenant through that tenant's administrator (an invitation).",
          );
        }
        await addTenantMember(db, user.id, 'member', actor);
        await asEngineRole(db, () =>
          sql`INSERT INTO zv_identity_links (tenant_id, provider, subject, user_id, active)
              VALUES (${tenant}::uuid, ${extName}, ${subject}, ${user.id}, ${active})`.execute(db),
        );
        if (!active) await enforce(db, tenant, await linked(db, tenant, subject), false);
        await audit(db, 'identity.provisioned', tenant, user.id, subject, { active });
        return read(db, tenant, subject);
      }),

    update: (subject, patch) =>
      act('update', async (db, tenant) => {
        const row = await linked(db, tenant, subject);
        await refuseLapsed(db, tenant, row);
        // Only what differs: an identity provider resends the whole profile on
        // every sync, and an unchanged push writes nothing.
        const change: { name?: string; email?: string } = {};
        if (patch?.name !== undefined && patch.name !== row.name) change.name = patch.name;
        if (
          patch?.email !== undefined &&
          String(patch.email).trim().toLowerCase() !== row.email.toLowerCase()
        ) {
          change.email = patch.email;
        }
        if (change.name === undefined && change.email === undefined) {
          return account(row, await solo(db, tenant));
        }
        // An account this tenant does not alone hold (another tenant's member,
        // an instance admin) is refused `user_not_owned`: its password reset
        // follows the address.
        await updateUserProfile(db, row.id, change, actor);
        await audit(db, 'identity.updated', tenant, row.id, row.subject, {
          fields: Object.keys(change),
        });
        return read(db, tenant, row.subject);
      }),

    setActive: (subject, active) =>
      act('setActive', async (db, tenant) => {
        if (typeof active !== 'boolean') {
          throw new IdentityRefusedError('invalid_input', 'setActive takes true or false.');
        }
        const row = await linked(db, tenant, subject);
        await refuseLapsed(db, tenant, row);
        await enforce(db, tenant, row, active);
        await audit(db, 'identity.active_set', tenant, row.id, row.subject, { active });
        return read(db, tenant, row.subject);
      }),

    remove: (subject) =>
      act('remove', async (db, tenant) => {
        // Open on a lapsed membership too: the provider must be able to remove
        // the person from this tenant.
        const row = await linked(db, tenant, subject);
        // Membership is what goes. A person can work for two tenants, and one
        // offboarding must not erase the account the other still uses; the
        // account goes only when nothing holds it any more.
        const gone = await removeTenantMember(db, row.id, actor);
        await asEngineRole(db, () =>
          sql`DELETE FROM zv_identity_links
               WHERE tenant_id = ${tenant}::uuid AND provider = ${extName}
                 AND subject = ${row.subject}`.execute(db),
        );
        await audit(db, 'identity.removed', tenant, row.id, row.subject, {
          account_deleted: gone.orphaned,
        });
        if (gone.orphaned) {
          await deleteUser(db, getDb(), row.id, {
            actor,
            reason: 'identity.remove',
            metadata: { tenant_id: tenant, provider: extName, subject: row.subject },
          });
        } else if (!gone.inForceAnywhere) {
          // Only lapsed memberships left: nothing to sign in to, so the sessions
          // go. While another tenant has the person in force the session stays.
          await revokeThroughCommit(db, getDb(), row.id);
        }
      }),

    list: (query = {}) =>
      act('list', async (db, tenant) => {
        const everyone = await solo(db, tenant);
        const email = query.email === undefined ? undefined : String(query.email);
        return (
          await links(db, tenant, {
            ...(email !== undefined ? { email } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
          })
        ).map((r) => account(r, everyone));
      }),

    get: (subject) =>
      act('get', async (db, tenant) => {
        const row = (await links(db, tenant, { subject: subjectOf(subject), limit: 1 }))[0];
        return row ? account(row, await solo(db, tenant)) : null;
      }),
  };
}
