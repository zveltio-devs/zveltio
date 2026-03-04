// packages/engine/src/middleware/tenant.ts
// Resolves tenant and environment from each request and attaches to context

import { createMiddleware } from 'hono/factory';
import {
  resolveTenantFromRequest,
  resolveEnvironment,
  getTenantSchemaName,
  setCurrentTenant,
  type Tenant,
  type Environment,
} from '../lib/tenant-manager.js';

declare module 'hono' {
  interface ContextVariableMap {
    tenant: Tenant | null;
    tenantSchema: string;
    environment: Environment | null;
  }
}

export const tenantMiddleware = createMiddleware(async (c, next) => {
  const hostname = c.req.header('host')?.split(':')[0];
  const tenant = await resolveTenantFromRequest(c.req.raw.headers, hostname);

  c.set('tenant', tenant);

  if (tenant) {
    // GOLDEN RULE: isolation through PostgreSQL RLS, not manual WHERE.
    // SET LOCAL activates the tenant_isolation policy for the current transaction.
    // If we're not in a transaction, it fails silently (catch) — RLS will block
    // access anyway through current_setting('zveltio.current_tenant', true) = NULL.
    await setCurrentTenant(tenant.id).catch(() => {});

    const env = await resolveEnvironment(tenant, c.req.raw.headers);
    c.set('environment', env);
    // Use environment-specific schema if available, else fall back to tenant default schema
    c.set(
      'tenantSchema',
      env ? env.schema_name : getTenantSchemaName(tenant.slug),
    );
  } else {
    c.set('environment', null);
    c.set('tenantSchema', 'public');
  }

  await next();
});
