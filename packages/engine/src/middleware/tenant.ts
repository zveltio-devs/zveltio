// packages/engine/src/middleware/tenant.ts
// Resolves tenant and environment from each request and attaches to context

import { createMiddleware } from 'hono/factory';
import type { Database } from '../db/index.js';
import { beginTracedTransaction, endTracedTransaction } from '../db/connection-trace.js';

/**
 * End the traced window and report what it saw.
 *
 * Anything above zero is a route that cannot be served at `c = DB_POOL_MAX`:
 * every connection is held by a transaction whose owner is waiting for one more.
 * Reported as a header so a probe reads the property directly instead of
 * inferring it from a hang — the inference version named the wrong routes and
 * kept naming them after they were fixed.
 */
function closeTracedWindow(c: { res: Response }): void {
  const extra = endTracedTransaction();
  if (extra > 0) c.res.headers.set('x-zveltio-extra-connections', String(extra));
}
import {
  resolveTenantFromRequest,
  resolveEnvironment,
  getTenantSchemaName,
  withTenantIsolation,
  type Tenant,
  type Environment,
} from '../lib/tenancy/index.js';
import {
  checkPermission,
  getUserRoles,
  resolveUserRole,
  type RlsIdentity,
  runWithDomain,
  setCurrentTenantTrx,
} from '../lib/tenancy/index.js';

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

  // ── Routers built on `poolDb` ──────────────────────────────────────────
  //
  // These four are handed the raw pool in `routes/index.ts` and never read
  // `tenantTrx`. Opening a transaction for them was not merely wasted: it was
  // the one remaining way to make the engine deadlock.
  //
  // A request inside the tenant transaction has RESERVED one pooled connection.
  // A handler running on `poolDb` then needs a SECOND one. At a concurrency
  // equal to the pool size, every request holds one and waits for one, and
  // nothing can release. Measured on this branch, DB_POOL_MAX=10, against
  // `/api/insights/dashboards`:
  //
  //   c=5   →  10ms p50, 0 failures, 530 req/s
  //   c=10  →  12 000ms p50, 20 520ms p95, 55 of 60 requests failed, 1 req/s
  //
  // `pg_stat_activity` during the second row: ten connections `idle in
  // transaction`, zero `active`. Not load — a standstill.
  //
  // The same benchmark on `/api/me`, which pins one connection and asks for no
  // second, is flat to c=120 (177ms p50, no failures) and indistinguishable
  // from the same route with no transaction at all. That contrast is the whole
  // point: the cost is not the request transaction, it is holding it while
  // reaching for another connection.
  //
  // Skipping is safe here because none of the four relies on the GUC. `insights`
  // and `flows` filter by `tenant_id` explicitly through `tenantOf(c)` — they
  // have to, being on the pool — and `backup` and `sql-editor` are
  // instance-level tools with no tenant scope at all.
  //
  // `/api/users` is deliberately NOT here. It takes `poolDb` as a THIRD
  // argument, used only to revoke sessions on delete, and runs everything else
  // on the request transaction. Skipping it would drop RLS for the whole
  // router to spare one cold path.
  //
  // `check-pooldb-txn-skip.ts` keeps this list and `routes/index.ts` in
  // agreement, so a router moved onto `poolDb` tomorrow cannot reintroduce the
  // standstill silently.
  '/api/insights',
  '/api/flows',
  '/api/backup',
  '/api/admin/sql',
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
          // The identity the row-rule policies read. Built from the session the
          // prefetch already resolved, so it costs no extra lookup on the hot
          // path — the roles and the bypass permission are both cached.
          //
          // `bypass` is the same question `getRlsFilters` asks before applying
          // any rule, asked once here and published as an answer. Two enforcers
          // of one rule must not disagree about who is exempt.
          const prefetched = c.get('prefetchedSession') as
            | { user?: { id?: string; email?: string; role?: string } }
            | null
            | undefined;
          const sessionUser = prefetched?.user;
          let identity: RlsIdentity | undefined;
          if (sessionUser?.id) {
            const [roles, bypass] = await Promise.all([
              getUserRoles(sessionUser.id).catch(() => [] as string[]),
              checkPermission(sessionUser.id, 'data', 'view_all').catch(() => false),
            ]);
            // The role is RESOLVED, not read off the session.
            //
            // better-auth does not populate `session.user.role`, so publishing
            // it gave the database an empty string — which its guard reads as
            // "cannot resolve" and skips the rule, while the engine bound
            // `undefined` and returned nothing. One rule, three behaviours,
            // found by an independent audit. `resolveUserRole` is what
            // `getRlsFilters` would have used, and it is already primed by
            // `sessionPrefetch`, so this costs no lookup.
            const direct = sessionUser.role || (await resolveUserRole({ id: sessionUser.id }));
            identity = {
              userId: sessionUser.id,
              email: sessionUser.email ?? '',
              role: direct,
              roles: direct && !roles.includes(direct) ? [...roles, direct] : roles,
              bypass,
            };
          }

          await withTenantIsolation(
            tenant.id,
            async (trx) => {
              // Traced only when ZVELTIO_TRACE_CONNECTIONS=1; a no-op otherwise.
              beginTracedTransaction();
              c.set('tenantTrx', trx);
              // H-12: also expose the tenant transaction via the ALS store so an
              // extension's `ctx.db` (which has no Hono context inside a hook or
              // background job) is RLS-scoped to this tenant, not the global pool.
              setCurrentTenantTrx(trx);
              try {
                await next();
              } finally {
                // ALWAYS closed, even when the handler throws.
                //
                // Without the `finally` an error inside the transaction left the
                // window open for the life of the process, and every connection
                // taken afterwards — by any request, on any path — was charged
                // to it. In CI that showed up as the data route "taking" a
                // connection that `sessionPrefetch` had taken for someone else,
                // BEFORE its transaction existed. A counter that can get stuck
                // reports somebody else's work as yours.
                closeTracedWindow(c);
              }
              // How many pool connections this request wanted ON TOP of the one
              // it is holding. Anything above zero is a route that cannot be
              // served at `c = DB_POOL_MAX`. Reported as a header so a probe can
              // read the property directly instead of inferring it from a hang.
            },
            { userId: actingUserId, identity },
          );
        }
      });
    } else {
      // An EXPLICIT `x-tenant-slug` that resolves to nothing is refused, rather
      // than served without a tenant.
      //
      // `getTenantBySlug` filters `status = 'active'`, so this covers both a
      // slug that does not exist and one whose tenant is SUSPENDED — and the
      // suspended case is the realistic one: the 403 twenty lines above can
      // never fire through this path, because the lookup feeding it already
      // dropped the row.
      //
      // Continuing without a tenant is not merely unscoped, it is an
      // escalation: no store means `getCurrentDomain()` reads as the root
      // tenant, and `requireInstanceAdmin` then admits a delegated
      // `tenant_admin`. Measured against /api/admin/rls on 2026-09-04 — 403
      // with a real tenant slug, 200 with one that does not exist.
      //
      // One status for both cases on purpose: distinguishing them would tell an
      // unauthenticated caller which slugs exist.
      if (c.req.raw.headers.get('x-tenant-slug')) {
        return c.json(
          {
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            code: 'tenant_not_found',
            detail: 'No active tenant matches the x-tenant-slug header.',
          },
          404,
        );
      }
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
