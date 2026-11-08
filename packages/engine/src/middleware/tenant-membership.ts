// packages/engine/src/middleware/tenant-membership.ts
//
// Enforces that an AUTHENTICATED caller actually belongs to the tenant that
// `tenantMiddleware` resolved (from X-Tenant-Slug / subdomain). Without this,
// any logged-in user could pivot to another tenant by sending its slug and —
// since the tenant GUC would then be set to that tenant — read its data.
//
// Design (see docs/platform/multi-tenancy.md):
//   - No-op when NO tenant is resolved (public traffic).
//   - The default tenant counts every authenticated user it has not withdrawn
//     (`tenantAdmits`): a plain single-tenant install enrols nobody, and a user
//     with no `zv_tenant_users` row there is implicitly a member. A user whose
//     every row there has lapsed was withdrawn and is refused, as elsewhere —
//     the gate used to wave the default tenant through before any check, so
//     such a user reached every handler under a NO_UNITS reach (#1586).
//   - Only enforces for AUTHENTICATED users. Unauthenticated requests fall
//     through to the route's own auth guard (which returns 401) — membership is
//     about access by a real user, not a substitute for auth. An API key is held
//     to its issuer's standing at the key door (`apiKeyActsIn`).
//   - God / super-admin users bypass (cross-tenant operators).
//   - Inside the request's transaction the answer is the reach it resolved;
//     elsewhere (TXN_SKIP_PREFIXES) it is read uncached, so a withdrawal by date
//     counts on the next request.

import { createMiddleware } from 'hono/factory';
import { requestSession } from './session-prefetch.js';
import type { Database } from '../db/index.js';
import {
  getResolvedMembership,
  isGodUser,
  membershipStanding,
  tenantAdmits,
} from '../lib/tenancy/index.js';
import { problem } from '../lib/problem.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function tenantMembershipMiddleware(auth: any, db: Database) {
  return createMiddleware(async (c, next) => {
    const tenant = c.get('tenant') as { id: string } | null;
    if (!tenant) return next();

    let userId: string | null = null;
    try {
      const session = await requestSession(c, auth);
      userId = session?.user?.id ?? null;
    } catch {
      /* unauthenticated — fall through to the route's own guard */
    }
    if (!userId) return next();

    // Cross-tenant operators (god / super-admin) are exempt.
    if (await isGodUser(userId)) return next();

    // The request's transaction already resolved this user's reach in this
    // tenant, and the reach is the membership answer (`withTenantIsolation`).
    // Only routes that open no transaction (TXN_SKIP_PREFIXES) ask below.
    const standing =
      getResolvedMembership(userId, tenant.id) ??
      // fabricated-ok: a `null` standing throws a 403 below. An unreadable membership denies access rather than granting it.
      (await membershipStanding(db, userId, tenant.id).catch(() => null));

    if (!standing || !tenantAdmits(tenant.id, standing)) {
      throw problem(
        'tenant.membership_required',
        403,
        'You are not a member of this tenant. Access denied.',
      );
    }
    return next();
  });
}
