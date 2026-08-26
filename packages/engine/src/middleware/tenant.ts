// packages/engine/src/middleware/tenant.ts
// Resolves tenant and environment from each request and attaches to context

import { createMiddleware } from 'hono/factory';
import type { Database } from '../db/index.js';
import {
  resolveTenantFromRequest,
  resolveEnvironment,
  getTenantSchemaName,
  withTenantIsolation,
  type Tenant,
  type Environment,
} from '../lib/tenancy/index.js';
import { runWithDomain, setCurrentTenantTrx } from '../lib/tenancy/index.js';

declare module 'hono' {
  interface ContextVariableMap {
    tenant: Tenant | null;
    tenantSchema: string;
    environment: Environment | null;
    // Transactional DB connection with SET LOCAL tenant GUC active.
    // Route handlers MUST use this (via c.get('tenantTrx') || db) for RLS to work.
    tenantTrx: Database | null;
  }
}

// Paths that never read tenant-scoped collection data — skip the per-request
// tenant transaction for them so we don't hold a pooled connection on trivial
// endpoints. Everything else under /api/* and /ext/* gets the transaction
// (covers /api/data, content routes, and all extension routes), so no RLS'd
// table is ever read without the GUC set.
//
// Schema-management routes (collections/relations/schema/templates) operate on
// GLOBAL metadata, not tenant rows, AND they enqueue DDL that runs `CREATE INDEX
// CONCURRENTLY` — which blocks until all concurrent transactions finish. Holding
// a tenant transaction across such a request deadlocks it against its own index
// build, so they MUST NOT open one.
const TXN_SKIP_PREFIXES = [
  '/api/health',
  '/api/metrics',
  '/api/auth',
  '/api/openapi',
  '/api/collections',
  '/api/relations',
  '/api/schema',
  '/api/templates',
  // Administering tenants is not work INSIDE a tenant.
  //
  // Provisioning creates the tenant row through the pool — it has to, because a
  // tenant that exists only inside one request's uncommitted transaction cannot
  // be referenced by anything else — and the route then writes the tenant's
  // first environment. Once the route ran inside a tenant transaction those two
  // writes landed on different connections, and the environment INSERT failed
  // its foreign key against a tenant row it could not yet see.
  //
  // Creating tenant B while scoped to tenant A is cross-tenant by definition,
  // so scoping it was the error, not the pool write it collided with.
  '/api/tenants',
];

export const tenantMiddleware = createMiddleware(async (c, next) => {
  const hostname = c.req.header('host')?.split(':')[0];

  try {
    const tenant = await resolveTenantFromRequest(c.req.raw.headers, hostname);
    c.set('tenant', tenant);
    c.set('tenantTrx', null);

    if (tenant) {
      if (tenant.status !== 'active') {
        return c.json({ error: 'Tenant account is suspended' }, 403);
      }

      const env = await resolveEnvironment(tenant, c.req.raw.headers);
      c.set('environment', env);
      c.set('tenantSchema', env ? env.schema_name : getTenantSchemaName(tenant.slug));

      // Carry the tenant as the authorization DOMAIN for the whole request so
      // checkPermission()/getUserRoles() resolve per-tenant Casbin policies
      // without threading an argument through every call site.
      await runWithDomain(tenant.id, async () => {
        // Transaction scoping: only open the isolation transaction for routes
        // that may touch tenant data. SET LOCAL is transaction-scoped, so any
        // query that must see tenant data has to run on this `tenantTrx`.
        const path = c.req.path;
        if (TXN_SKIP_PREFIXES.some((p) => path.startsWith(p))) {
          await next();
        } else {
          // The acting user, so the transaction can resolve their reach into
          // the visible-set GUCs. `sessionPrefetch` runs before this middleware
          // precisely so the lookup is already done on a pool connection as the
          // engine's own role — asking again here would be a second query, and
          // asking INSIDE the transaction would ask as `zveltio_rls`, which is
          // refused `session` and would abort the whole request.
          //
          // Absent for public traffic and API keys, which is correct: with no
          // user there is no assignment to resolve, and the predicate answers
          // with the single-unit equality it always used.
          const actingUserId =
            (c.get('prefetchedSession') as { user?: { id?: string } } | null | undefined)?.user
              ?.id ?? null;
          await withTenantIsolation(
            tenant.id,
            async (trx) => {
              c.set('tenantTrx', trx);
              // H-12: also expose the tenant transaction via the ALS store so an
              // extension's `ctx.db` (which has no Hono context inside a hook or
              // background job) is RLS-scoped to this tenant, not the global pool.
              setCurrentTenantTrx(trx);
              await next();
            },
            { userId: actingUserId },
          );
        }
      });
    } else {
      c.set('environment', null);
      c.set('tenantSchema', 'public');
      await next();
    }
  } catch (err) {
    // Saturation is not a server fault, and answering 500 tells the caller to
    // give up when it should retry. Before this branch existed the request did
    // not even get that far: `pool.reserve()` had no deadline, so a saturated
    // engine stopped answering altogether instead of refusing.
    if ((err as { code?: string })?.code === 'pool_busy') {
      console.warn('[Tenant Middleware] pool saturated — refusing rather than queueing:', err);
      c.header('Retry-After', '1');
      return c.json(
        {
          type: 'about:blank',
          title: 'Service Unavailable',
          status: 503,
          code: 'pool_busy',
          detail: 'The database connection pool is saturated. Retry shortly.',
        },
        503,
      );
    }
    console.error('[Tenant Middleware] Critical: failed to establish tenant context:', err);
    return c.json(
      { error: 'Could not establish tenant context. Request rejected for security.' },
      500,
    );
  }
});
