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

      // Security: wrap the entire request in a PostgreSQL transaction so that
      // SET LOCAL "zveltio.current_tenant" persists for ALL queries made via
      // the `tenantTrx` connection. Routes must use c.get('tenantTrx') || db.
      // Without this transaction, SET LOCAL is silently ignored (connection pool
      // routes queries to arbitrary connections) and RLS policies are inactive.
      await withTenantIsolation(tenant.id, async (trx) => {
        c.set('tenantTrx', trx);
        await next();
      });
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
