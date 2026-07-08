// packages/engine/src/middleware/tenant-membership.ts
//
// Enforces that an AUTHENTICATED caller actually belongs to the tenant that
// `tenantMiddleware` resolved (from X-Tenant-Slug / subdomain). Without this,
// any logged-in user could pivot to another tenant by sending its slug and —
// since the tenant GUC would then be set to that tenant — read its data.
//
// Design (see docs/MULTI-TENANT-ENABLEMENT.md §3):
//   - No-op when NO tenant is resolved (single-tenant / public traffic) — the
//     check costs nothing and changes nothing for the default self-hosted model.
//   - Only enforces for AUTHENTICATED users. Unauthenticated requests fall
//     through to the route's own auth guard (which returns 401) — membership is
//     about cross-tenant access by a real user, not a substitute for auth.
//   - God / super-admin users bypass (cross-tenant operators).
//   - `zv_tenant_users` is a global table (not tenant-RLS'd), so the membership
//     lookup uses the global pool, not the per-request tenant transaction.

import { createMiddleware } from 'hono/factory';
import type { Database } from '../db/index.js';
import { isGodUser } from '../lib/tenancy/index.js';
import { DEFAULT_TENANT_ID } from '../lib/tenancy/index.js';
import { problem } from '../lib/problem.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function tenantMembershipMiddleware(auth: any, db: Database) {
  return createMiddleware(async (c, next) => {
    const tenant = c.get('tenant') as { id: string } | null;
    // No tenant, or the implicit default tenant (single-tenant space) → no
    // membership requirement. Membership is enforced only for explicitly
    // resolved NON-default tenants (real multi-tenant via header/subdomain),
    // so single-tenant installs keep working for every authenticated user.
    if (!tenant || tenant.id === DEFAULT_TENANT_ID) return next();

    let userId: string | null = null;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      userId = session?.user?.id ?? null;
    } catch {
      /* unauthenticated — fall through to the route's own guard */
    }
    if (!userId) return next();

    // Cross-tenant operators (god / super-admin) are exempt.
    if (await isGodUser(userId)) return next();

    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const member = await (db as any)
      .selectFrom('zv_tenant_users')
      .select('user_id')
      .where('tenant_id', '=', tenant.id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
      .catch(() => null);

    if (!member) {
      throw problem(
        'tenant.membership_required',
        403,
        'You are not a member of this tenant. Access denied.',
      );
    }
    return next();
  });
}
