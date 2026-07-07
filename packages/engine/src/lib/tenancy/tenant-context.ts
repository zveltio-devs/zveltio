// packages/engine/src/lib/tenant-context.ts
//
// Carries the current request's tenant DOMAIN for authorization, via
// AsyncLocalStorage. This lets `checkPermission(userId, resource, action)` and
// `getUserRoles(userId)` resolve the per-tenant Casbin domain WITHOUT threading
// a new argument through ~250 call sites (engine + 54 extensions).
//
// `tenantMiddleware` runs each request inside `runWithDomain(tenant.id, …)`.
// Outside a request (background jobs, CLI, boot), `getCurrentDomain()` returns
// the default tenant — and migrated policies live at domain '*', which matches
// every domain, so authorization is unchanged until per-tenant policies exist.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '../../db/index.js';
import { DEFAULT_TENANT_ID } from './tenant-manager.js';

// The store also carries the request/job tenant TRANSACTION (H-12) — the same
// `SET LOCAL "zveltio.current_tenant"` transaction the middleware opens — so an
// extension's `ctx.db` can resolve it WITHOUT the Hono context (which extension
// code called from a hook or background job doesn't have). `trx` is filled in
// AFTER the store is opened (the transaction is created inside `runWithDomain`),
// so the store value is a mutable object rather than a frozen `{ domain }`.
interface TenantStore {
  domain: string;
  trx?: Database;
}

const store = new AsyncLocalStorage<TenantStore>();

export function runWithDomain<T>(domain: string, fn: () => T): T {
  return store.run({ domain }, fn);
}

export function getCurrentDomain(): string {
  return store.getStore()?.domain ?? DEFAULT_TENANT_ID;
}

/**
 * Record the current request/job tenant transaction in the ALS store. Called by
 * the tenant middleware (and the job-context factory) right after
 * `withTenantIsolation` opens the transaction. No-op outside a store (boot/CLI).
 */
export function setCurrentTenantTrx(trx: Database): void {
  const s = store.getStore();
  if (s) s.trx = trx;
}

/**
 * The active request/job tenant transaction, or `undefined` when there is none
 * (boot, CLI, or a background path that didn't establish tenant context).
 * An extension's `ctx.db` resolves this so its queries are RLS-scoped to the
 * current tenant; callers fall back to the global pool when it's undefined.
 */
export function getCurrentTenantTrx(): Database | undefined {
  return store.getStore()?.trx;
}
