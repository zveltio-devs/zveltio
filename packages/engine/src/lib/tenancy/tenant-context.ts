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

/**
 * Run `fn` with a tenant transaction bound to the async context, opening a
 * store if there is not one already.
 *
 * `setCurrentTenantTrx` is a no-op outside a store, which is exactly the case
 * for background work: a request enters `runWithDomain` first and then fills in
 * the transaction, but a job has neither. So `ctx.db` — the proxy that resolves
 * this — fell through to the global pool inside every scheduled task, queue
 * worker and fire-and-forget job in the ecosystem, while being correctly scoped
 * in the handler that started them.
 *
 * With this, `ctx.db` means the same thing everywhere, and extensions no longer
 * need a second spelling for background code.
 *
 * A nested call inherits the enclosing store's domain, so a
 * `withTenantIsolation` inside a request does not lose it.
 */
export function runWithTenantTrx<T>(trx: Database, tenantId: string, fn: () => T): T {
  // ALWAYS a new context. Never mutate the one we are standing in.
  //
  // This used to take a second branch when a store already existed: assign
  // `existing.trx = trx`, call `fn()`, and restore the previous value in a
  // `finally`. That `finally` is SYNCHRONOUS and `fn` is not. `fn()` returns a
  // promise the instant it hits its first `await`, the `finally` runs right
  // then, and the transaction is put back to `undefined` before the handler has
  // issued a single query. Everything after that first await — which is all of
  // a request handler — ran with no tenant transaction at all.
  //
  // `ctx.db` resolves through `getCurrentTenantTrx()` and falls back to the
  // global pool, which on a standard install connects as a superuser, which RLS
  // does not apply to. So 302 `tenant_isolation` policies across 350 extension
  // tables were inert on the request path: reads crossed tenants, updates ran
  // without a tenant predicate, and every row an extension wrote landed in the
  // DEFAULT tenant because the column default reads a GUC that was never set.
  // An audit measured it as CRM returning 12 rows where the core returned 11,
  // and rode it all the way to deleting the instance administrator through a
  // SCIM token issued for an ordinary tenant.
  //
  // The branch existed for a good reason — background jobs have no store, and
  // `ctx.db` used to fall through to the global pool inside every scheduled
  // task — and it was written to reuse an open store so a nested call would not
  // lose the domain. It fixed the untested path and broke the tested one, then
  // went unnoticed because the branch that WORKS is the one jobs take, and jobs
  // are where the tests are.
  //
  // AsyncLocalStorage already does exactly what the manual save/restore was
  // reaching for, and does it per async context rather than per shared object,
  // so nesting is correct by construction. The domain of an enclosing store is
  // carried forward so the original intent — a nested `withTenantIsolation`
  // inside a request keeps its domain — still holds.
  const existing = store.getStore();
  return store.run({ domain: existing?.domain ?? tenantId, trx }, fn);
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
