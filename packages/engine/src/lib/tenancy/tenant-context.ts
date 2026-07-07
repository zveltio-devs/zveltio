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
import { DEFAULT_TENANT_ID } from './tenant-manager.js';

const store = new AsyncLocalStorage<{ domain: string }>();

export function runWithDomain<T>(domain: string, fn: () => T): T {
  return store.run({ domain }, fn);
}

export function getCurrentDomain(): string {
  return store.getStore()?.domain ?? DEFAULT_TENANT_ID;
}
