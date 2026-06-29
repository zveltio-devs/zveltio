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
} from '../lib/tenant-manager.js';

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

      // Transaction scoping: only open the isolation transaction for routes that
      // may touch tenant data. SET LOCAL is transaction-scoped, so any query
      // that must see tenant data has to run on this `tenantTrx` connection.
      const path = c.req.path;
      if (TXN_SKIP_PREFIXES.some((p) => path.startsWith(p))) {
        await next();
      } else {
        await withTenantIsolation(tenant.id, async (trx) => {
          c.set('tenantTrx', trx);
          await next();
        });
      }
    } else {
      c.set('environment', null);
      c.set('tenantSchema', 'public');
      await next();
    }
  } catch (err) {
    console.error('[Tenant Middleware] Critical: failed to establish tenant context:', err);
    return c.json(
      { error: 'Could not establish tenant context. Request rejected for security.' },
      500,
    );
  }
});
