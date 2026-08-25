// packages/engine/src/middleware/session-prefetch.ts
//
// Resolve the session BEFORE the tenant transaction opens.
//
// `tenantMiddleware` runs the whole request inside `withTenantIsolation`, which
// does `SET LOCAL ROLE zveltio_rls` — a role that deliberately cannot read
// Better Auth's tables. Migration 044 leaves `session`, `account`, `user`,
// `verification` and `twoFactor` without RLS precisely so nothing scopes them,
// and `zveltio_rls` is not granted SELECT on them because an extension holding
// that role must never read `session.token`.
//
// So every route that authenticates INSIDE the transaction asks a role that is
// forbidden to answer. Measured with a probe at the call site:
//
//   [authenticate] db => current_user=zveltio_rls tenant=00000000-…
//   ERROR [Better Auth]: permission denied for table session
//
// The failure is not the 401 it produces. `permission denied` ABORTS the
// transaction, so every later statement on that connection answers "current
// transaction is aborted" — the request log, the tenant context, whatever ran
// next. One forbidden read poisons the rest of the request. Under load: 35
// permission errors and 84 aborted-transaction errors in a single run, and
// requests that had nothing to do with any of it answering 401 and 500.
//
// Resolving the session here, on the pool, before any role is dropped, removes
// the forbidden read rather than permitting it. Granting `zveltio_rls` SELECT on
// `session` would also make the errors vanish — it was tried, and it works — but
// it hands every extension the session table, which is the thing migration 043
// and the worker-role split exist to prevent.
//
// `authenticate()` reads the cached value, so nothing pays for a second lookup.

import { createMiddleware } from 'hono/factory';

/** Resolved once per request, before the tenant transaction. `null` = anonymous. */
export type PrefetchedSession = { user: unknown } | null;

declare module 'hono' {
  interface ContextVariableMap {
    /** Absent when the prefetch did not run; `null` when it ran and found none. */
    prefetchedSession?: PrefetchedSession;
  }
}

/**
 * Mounted BEFORE `tenantMiddleware`, so `getSession` runs on a pool connection
 * as the engine's own role.
 *
 * A failure here is not fatal: the request continues without a cached session
 * and whatever authenticates later falls back to asking directly. That path is
 * the one this exists to avoid, not a path that must not exist — a transient
 * lookup failure should not turn into a 500 before the route is even reached.
 */
// biome-ignore lint/suspicious/noExplicitAny: better-auth instance — no exported type, matches every other call site
export function sessionPrefetch(auth: any) {
  return createMiddleware(async (c, next) => {
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      c.set('prefetchedSession', (session ?? null) as PrefetchedSession);
    } catch {
      /* leave unset — callers fall back to their own lookup */
    }
    await next();
  });
}
