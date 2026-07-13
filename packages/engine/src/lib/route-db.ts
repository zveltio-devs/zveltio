/**
 * Per-request DB resolver — returns the tenant-isolated transaction
 * (set by `tenantMiddleware`) when one is active, otherwise falls back
 * to the global pool.
 *
 * Why this matters: in multi-tenant mode the engine relies on Postgres
 * `SET LOCAL "zveltio.current_tenant"` + FORCE ROW LEVEL SECURITY for
 * isolation. SET LOCAL is transaction-scoped, so *every* query that
 * should see tenant data must run on the same transaction that issued
 * the SET. The middleware stores that transaction in `c.get('tenantTrx')`.
 *
 * Routes that bypass this and use the bare pool either:
 *   - return zero rows (FORCE RLS sees no tenant GUC → policy denies), or
 *   - silently miss the per-tenant scope on tables not yet RLS'd
 *
 * Standard usage in a handler:
 *
 *     app.get('/things', async (c) => {
 *       const tdb = reqDb(c, db);
 *       return c.json(await tdb.selectFrom('zvd_things').selectAll().execute());
 *     });
 *
 * Pass the route's `db` parameter as the fallback so single-tenant
 * deployments (no tenantMiddleware active) still work.
 */

import type { Context } from 'hono';
import type { Database } from '../db/index.js';

export function reqDb(c: Context, fallback: Database): Database {
  const trx = c.get('tenantTrx') as Database | null | undefined;
  return trx ?? fallback;
}

/** Default tenant id ("always-one-tenant") — single-tenant installs run as this. */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * The current request's tenant id. `tenantMiddleware` always resolves a tenant
 * (the default tenant in single-tenant installs), so this is always defined.
 * Use it to explicitly scope tables that are NOT yet under RLS (e.g.
 * `zv_media_files`) so one tenant can't reach another's rows by id.
 */
export function tenantId(c: Context): string {
  return (c.get('tenant') as { id?: string } | null | undefined)?.id ?? DEFAULT_TENANT_ID;
}
