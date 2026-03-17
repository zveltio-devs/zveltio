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

  try {
    const tenant = await resolveTenantFromRequest(c.req.raw.headers, hostname);

    c.set('tenant', tenant);

    if (tenant) {
      if (tenant.status !== 'active') {
        return c.json({ error: 'Tenant account is suspended' }, 403);
      }

      // Security: fail-closed — if RLS context cannot be set, reject the request.
      // A silent failure would leave the tenant GUC unset, causing RLS to be
      // inactive and potentially exposing data across tenants.
      await setCurrentTenant(tenant.id);

      const env = await resolveEnvironment(tenant, c.req.raw.headers);
      c.set('environment', env);
      c.set(
        'tenantSchema',
        env ? env.schema_name : getTenantSchemaName(tenant.slug),
      );
    } else {
      c.set('environment', null);
      c.set('tenantSchema', 'public');
    }
  } catch (err) {
    // RLS context could not be established — reject to prevent cross-tenant leakage.
    console.error('[Tenant Middleware] Critical: failed to establish tenant context:', err);
    return c.json(
      { error: 'Could not establish tenant context. Request rejected for security.' },
      500,
    );
  }

  await next();
});
