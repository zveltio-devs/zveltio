/**
 * tenant-guard.ts
 *
 * Ensures route handlers use the tenant-isolated DB connection rather than
 * the raw `db` pool. When a tenant context is present, this middleware sets
 * `c.set('db', tenantTrx)` so any code that reads `c.get('db')` automatically
 * gets the isolated connection with SET LOCAL GUC active.
 *
 * Usage:
 *   app.use('/api/data/*', tenantDbMiddleware);
 *   app.use('/api/zones/*', tenantDbMiddleware);
 *
 * Route handlers should prefer `c.get('tenantTrx') ?? db` but this middleware
 * makes the pattern opt-out rather than opt-in for covered routes.
 */

import { createMiddleware } from 'hono/factory';
import type { Database } from '../db/index.js';

declare module 'hono' {
  interface ContextVariableMap {
    // Effective DB for this request — equals tenantTrx when tenant is active,
    // falls back to the shared pool otherwise. Set by tenantDbMiddleware.
    effectiveDb: Database;
  }
}

/**
 * Sets `effectiveDb` on the context:
 *  - tenant present → uses the isolated `tenantTrx` connection (RLS active)
 *  - no tenant      → uses the shared pool (single-tenant / admin requests)
 *
 * Apply on routes that must respect tenant isolation:
 *   app.use('/api/data/*', tenantDbMiddleware(db));
 *   app.use('/api/zones/*', tenantDbMiddleware(db));
 */
export function tenantDbMiddleware(fallbackDb: Database) {
  return createMiddleware(async (c, next) => {
    const tenantTrx = c.get('tenantTrx');
    c.set('effectiveDb', tenantTrx ?? fallbackDb);
    await next();
  });
}
