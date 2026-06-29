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
import { isGodUser } from '../lib/permissions.js';

export function tenantMembershipMiddleware(auth: any, db: Database) {
  return createMiddleware(async (c, next) => {
    const tenant = c.get('tenant') as { id: string } | null;
    if (!tenant) return next(); // no tenant context → nothing to enforce

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

    const member = await (db as any)
      .selectFrom('zv_tenant_users')
      .select('user_id')
      .where('tenant_id', '=', tenant.id)
      .where('user_id', '=', userId)
      .executeTakeFirst()
      .catch(() => null);

    if (!member) {
      return c.json({ error: 'You are not a member of this tenant. Access denied.' }, 403);
    }
    return next();
  });
}
