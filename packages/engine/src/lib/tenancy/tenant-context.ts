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
  /**
   * True when this request's reach is exactly its own tenant — no hierarchy set
   * was published into `zveltio.visible_tenants`.
   *
   * Read by the data layer to add `tenant_id = <domain>` to a query as an
   * explicit predicate. That is a PERFORMANCE addition, never a security one:
   * the RLS policy is untouched and still decides what may be seen. The reason
   * it matters is that the policy reads `tenant_id = ANY (…)`, and `= ANY` over
   * an array the planner cannot see at plan time will not drive an ordered index
   * scan — so a paginated list scans `created_at` and throws away everyone
   * else's rows, at a cost proportional to how many tenants exist. Measured on
   * 300 000 rows: 1,94 ms and 6 408 rows discarded, against 0,08 ms and none
   * once the explicit equality lets `(tenant_id, created_at DESC)` be used.
   *
   * Undefined when a hierarchy IS in play, and then no filter is added — adding
   * one there would hide the ancestors' rows the request is entitled to.
   */
  singleTenant?: boolean;
  /**
   * Work that must not start until the transaction has COMMITTED.
   *
   * Four places used `setTimeout(…, 0)` for this — the request log, the god
   * audit, the slow-query log and the row-rule policy refresh — on the reasoning
   * that the transaction would be closed by the next tick. An independent audit
   * showed it is not: the timer fires with the transaction still open, so the
   * write takes a SECOND pooled connection, which is the thing all four were
   * changed to avoid.
   *
   * A queue drained after the commit says what was meant, instead of assuming
   * it.
   */
  afterCommit?: Array<() => void | Promise<void>>;
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
/**
 * Run `fn` as if no tenant transaction were open.
 *
 * For work that must NOT run under `zveltio_rls`: reading Better Auth's tables.
 * `session`, `account`, `user`, `verification` and `twoFactor` carry no RLS by
 * design (migration 044) and `zveltio_rls` is deliberately not granted SELECT on
 * them — an extension holding that role must never read `session.token`.
 *
 * So a session lookup inside the tenant transaction asks a role that is
 * forbidden to answer, and `permission denied` does not merely fail the lookup:
 * it ABORTS the transaction, so every later statement on that connection answers
 * "current transaction is aborted". One forbidden read poisons the rest of the
 * request — measured under load as 35 permission errors and 84 aborted-transaction
 * errors in a single run, surfacing as 401s and 500s on requests that had nothing
 * to do with any of it.
 *
 * Applied once, around `getSession` in `initAuth`, rather than at the 55 engine
 * and 99 extension call sites that ask for a session.
 *
 * `store.run` with a fresh object, never mutation — for the reason written above
 * `runWithTenantTrx`: a synchronous `finally` restoring a mutated field fires at
 * `fn`'s first await, long before it is done.
 */
export function runWithoutTenantTrx<T>(fn: () => T): T {
  const s = store.getStore();
  if (!s?.trx) return fn();
  return store.run({ ...s, trx: undefined }, fn);
}

/**
 * Run `fn` once the request's transaction has committed.
 *
 * Outside a transaction there is nothing to wait for, so it runs immediately —
 * which is what a background job or a boot reconciler wants.
 */
export function onAfterCommit(fn: () => void | Promise<void>): void {
  const current = store.getStore();
  if (!current) {
    void fn();
    return;
  }
  (current.afterCommit ??= []).push(fn);
}

/** Take the queued work. Called by `withTenantIsolation` after the commit. */
export function drainAfterCommit(): Array<() => void | Promise<void>> {
  const current = store.getStore();
  if (!current?.afterCommit) return [];
  const queued = current.afterCommit;
  current.afterCommit = [];
  return queued;
}

export function getCurrentTenantTrx(): Database | undefined {
  return store.getStore()?.trx;
}

/** Mark this request's reach as its own tenant alone. See `TenantStore`. */
export function setSingleTenantScope(single: boolean): void {
  const current = store.getStore();
  if (current) current.singleTenant = single;
}

/**
 * The tenant to add as an explicit equality, or `null` when one must not be
 * added — no store, no tenant, or a hierarchy is in play.
 */
export function getSingleTenantId(): string | null {
  const current = store.getStore();
  if (!current?.singleTenant) return null;
  return current.domain || null;
}

/**
 * A `Database` that resolves the CURRENT request's tenant transaction, falling
 * back to the pool when there is none. What `ctx.db` has meant for extensions
 * since H-12; core routes never got it.
 *
 * The dialect reserves a pooled connection when a transaction BEGINs and serves
 * every other query through `pool.unsafe()`. So a request inside
 * `withTenantIsolation` has pinned one connection, and each raw-pool query it
 * then makes has to find another free one. At a concurrency near the pool size
 * every request holds one and waits for one, and nothing can release.
 */
/**
 * How many times a request-scoped handle fell through to the raw pool.
 *
 * `createRequestScopedDb` resolves `getCurrentTenantTrx() ?? pool`. That `??` is
 * the quietest failure in the engine: with no transaction open, every
 * `db.selectFrom(...)` runs on the unscoped pool as the engine's own role, so a
 * tenant-scoped read returns every tenant's rows — and nothing throws, warns, or
 * logs. The caller gets data and believes it.
 *
 * The fallback is not itself a bug: boot code and extension load-time work
 * legitimately hold this handle with no request around them. What was missing is
 * any way to TELL the two apart, which is why "just open the transaction later"
 * has never been a small change — getting it wrong is invisible.
 *
 * So: count it, and let a test assert the count. That turns a class of silent
 * cross-tenant reads into a red test, and it is the precondition for Block A,
 * where the transaction stops being held for the whole request.
 *
 * `ZVELTIO_STRICT_TENANT_SCOPE=1` turns the count into a throw, for anyone who
 * wants the failure immediately rather than at the end of a test. Off by
 * default, deliberately: this ships as a diagnostic, not as a behaviour change,
 * and a throw here on a legitimate boot-time call would take a deployment down.
 */
let _unscopedFallbacks = 0;

/** Number of unscoped fallbacks since the last reset. See `_unscopedFallbacks`. */
export function getUnscopedFallbackCount(): number {
  return _unscopedFallbacks;
}

/** Reset the counter — for a test that wants to measure one stretch of work. */
export function resetUnscopedFallbackCount(): void {
  _unscopedFallbacks = 0;
}

/**
 * Kysely entry points that name a table. Only these are counted: reading
 * `db.fn`, `db.dynamic` or an internal property resolves nothing about a tenant
 * and would drown the signal in noise.
 */
const TABLE_ENTRY_POINTS = new Set([
  'selectFrom',
  'insertInto',
  'updateTable',
  'deleteFrom',
  'with',
]);

/**
 * Tables that carry `tenant_id`, learned from the live schema at boot.
 *
 * The counter needs this or it is useless. Its first run flagged three call
 * sites — `middleware/rate-limit.ts` reading `zv_rate_limit_configs`,
 * `ddl-manager.getCollections` reading `zvd_collections`, `routes/tenants.ts`
 * reading `zv_tenants` — and all three are CORRECT: Block B classified every one
 * of those as instance-level, shared across tenants by design. A counter that
 * cannot tell a shared table from a tenant-scoped one reports working code as a
 * leak, which is how a gate gets switched off.
 *
 * Read from `information_schema` rather than a generated list: the answer is
 * derivable from the database itself, so there is nothing to keep in sync and
 * nothing to go stale. Until it is populated the counter stays silent, which is
 * the right answer for boot-time work anyway.
 */
let _tenantScopedTables: Set<string> | null = null;

/** Publish the tenant-scoped table set. Called once at boot, after migrations. */
export function setTenantScopedTables(tables: Iterable<string>): void {
  _tenantScopedTables = new Set([...tables].map((t) => t.toLowerCase()));
}

/** `selectFrom('zvd_x as a')` and `selectFrom('public.zvd_x')` both name `zvd_x`. */
function tableNameOf(arg: unknown): string | null {
  if (typeof arg !== 'string') return null;
  const first = arg.trim().split(/\s+/)[0] ?? '';
  const bare = first.split('.').pop() ?? '';
  return bare ? bare.replace(/"/g, '').toLowerCase() : null;
}

export function createRequestScopedDb(pool: Database): Database {
  return new Proxy({} as Database, {
    get(_dummy, prop: string | symbol) {
      const trx = getCurrentTenantTrx();
      const target = trx ?? pool;

      // `db.transaction()` JOINS the request's transaction instead of nesting.
      //
      // Kysely refuses `transaction()` on a Transaction — "calling the
      // transaction method for a Transaction is not supported" — and nine core
      // route files open one of their own: invitations, flows, insights, the
      // SQL editor, ERD layout, collections, relations, templates, config.
      // Handing them the request's transaction therefore turned every one of
      // those routes into a 500.
      //
      // That is what the first attempt at this got wrong, and it is worth
      // recording HOW: 28 harness tests failed, the failing names were
      // tenants / invitations / SQL editor / backup / saved queries, and the
      // conclusion drawn from the NAMES was "these routes must escape tenant
      // isolation, so this needs a per-route campaign". The change was reverted
      // on that reasoning. Reading the actual error showed something else
      // entirely: not one of those failures was about isolation, they were all
      // this one message, and the fix is here rather than in twenty routes.
      //
      // Joining is also the correct semantics. The route's work becomes part of
      // the transaction the request already has: it commits with it, rolls back
      // with it, and stays inside the same tenant scope — which is more
      // atomic than the separate transaction it used to open, not less.
      if (prop === 'transaction' && trx) {
        return () => {
          const builder = {
            // Kysely's TransactionBuilder is chainable; the ambient transaction
            // already has its isolation level and cannot be changed mid-flight,
            // so this accepts the call and keeps the chain working.
            setIsolationLevel: () => builder,
            setAccessMode: () => builder,
            execute: <T>(fn: (t: Database) => Promise<T>): Promise<T> => fn(trx),
          };
          return builder;
        };
      }

      // `unknown`, not `any`: a proxy reading an arbitrary key off Kysely knows
      // nothing about what comes back, and saying so keeps the narrowing below
      // honest rather than waving the checker through.
      // The fallback, made visible — but only for a table that actually carries a
      // tenant. See `_tenantScopedTables`: the first version counted every call
      // and flagged three pieces of correct code reading shared tables.
      if (!trx && typeof prop === 'string' && TABLE_ENTRY_POINTS.has(prop) && _tenantScopedTables) {
        const inner = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop];
        if (typeof inner === 'function') {
          return (...args: unknown[]) => {
            const table = tableNameOf(args[0]);
            if (table && _tenantScopedTables?.has(table)) {
              _unscopedFallbacks++;
              if (process.env.ZVELTIO_STRICT_TENANT_SCOPE === '1') {
                throw new Error(
                  `[tenant-scope] \`db.${prop}('${table}')\` ran with no tenant transaction ` +
                    'open, so it would have used the unscoped pool — and the engine connects as ' +
                    'a superuser, which bypasses row-level security entirely. Open one with ' +
                    'withTenantIsolation(), or reach for the raw pool deliberately. ' +
                    '(ZVELTIO_STRICT_TENANT_SCOPE=1)',
                );
              }
            }
            return inner.apply(target, args);
          };
        }
      }

      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;

      // Bind, then carry the original's own properties across.
      //
      // Some of what Kysely exposes is a CALLABLE OBJECT, not a plain method:
      // `db.fn` can be invoked as `fn('now', [])` and also carries `fn.count`,
      // `fn.sum` and friends. `Function.prototype.bind` returns a fresh function
      // and copies none of that, so `db.fn.count(...)` became "db.fn.count is
      // not a function" — a failure that looks like the route is wrong and is
      // entirely this proxy's doing.
      const bound = value.bind(target);
      Object.assign(bound, value);
      return bound;
    },
  });
}
