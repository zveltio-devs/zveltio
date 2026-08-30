/**
 * Is this extension acting for this firm?
 *
 * God installs an extension for the instance; the admin of a firm decides
 * whether it acts there. Two rows express that:
 *
 *   tenant_id IS NULL   god's install - on for every firm unless overridden
 *   tenant_id = <firm>  that firm admin's override, on or off
 *
 * The firm's row wins when both exist. A firm with no row inherits the global
 * one, so the upgrade from the single-row world changes nothing: rows written
 * before migration 007 have tenant_id IS NULL and stay active for everyone.
 *
 * What this is NOT: a load filter. Extensions register their routes, hooks and
 * migrations into one process, so "load it only for firm B" does not exist - a
 * firm that turned an extension off still has its code in memory. Activation is
 * a gate at the moment the extension would act, which is why the callers live
 * in `register.ts`, the one place that holds an extension's name together with
 * the handles it acts through, rather than on a URL prefix. A prefix would have
 * missed `registerPublicRoute`, which mounts outside `/ext/<name>/` by design.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getCurrentDomain } from '../tenancy/index.js';

/**
 * How long a resolved decision may be reused. Activation changes are rare and
 * the writers invalidate explicitly; this only bounds the damage of a writer we
 * forgot, and keeps a per-request query off the hot path.
 */
const TTL_MS = 10_000;

const cache = new Map<string, { value: boolean; at: number }>();

/** Drop cached decisions. Call after any write to `zv_extension_registry`. */
export function invalidateActivationCache(name?: string): void {
  if (!name) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) if (key.endsWith(` ${name}`)) cache.delete(key);
}

/**
 * Candidate registry names for a `/ext/...` path. Extension names may be scoped
 * (`audit/sweeptest`), so the first path segment alone is not always the name.
 */
export function extensionNameCandidates(rest: string): string[] {
  const parts = rest.split('/').filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [parts[0] as string];
  return [`${parts[0]}/${parts[1]}`, parts[0] as string];
}

async function resolve(db: Database, names: string[], tenantId: string): Promise<boolean> {
  if (names.length === 0) return false;
  // The firm's own row wins over the global one - `NULLS LAST` puts it first.
  // Both are covered by idx_zv_ext_registry_tenant_enabled.
  const res = await sql<{ is_enabled: boolean }>`
    SELECT is_enabled
      FROM zv_extension_registry
     WHERE name = ANY(${sql.val(names)}::text[])
       AND (tenant_id IS NULL OR tenant_id = ${tenantId})
     ORDER BY tenant_id NULLS LAST
     LIMIT 1
  `.execute(db);
  return res.rows[0]?.is_enabled === true;
}

/**
 * In-flight lookups, so a burst on a cold cache asks once.
 *
 * Not a micro-optimisation. This query runs on the pool while the request's own
 * transaction is still open, which is a SECOND connection held at the same time
 * — the exact shape that put `/api/insights` at DB_POOL_MAX with ten
 * connections `idle in transaction` and none active. With the cache, a firm
 * costs one lookup per extension per TTL; without this map, `c` simultaneous
 * cold requests would cost `c` of them at once, which is that bug again.
 */
const inFlight = new Map<string, Promise<boolean>>();

/** Whether `name` is active for `tenantId`. Absent everywhere means false. */
export async function isExtensionActiveForTenant(
  db: Database,
  name: string,
  tenantId: string,
): Promise<boolean> {
  const key = `${tenantId} ${name}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const running = inFlight.get(key);
  if (running) return running;

  const p = resolve(db, [name], tenantId)
    .then((value) => {
      cache.set(key, { value, at: Date.now() });
      return value;
    })
    .catch((err: Error) => {
      // Unknown, not "off". Activation is a firm's preference about a feature,
      // not an authorization decision — the extension's code is loaded either
      // way and every authz check downstream still runs. So a database that
      // cannot answer must not switch the product off for everyone; it fails
      // open, loudly, and caches nothing so the next request asks again.
      console.warn(`[activation] could not resolve "${name}" for ${tenantId}:`, err.message);
      return true;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/**
 * Whether `name` is active for at least one firm.
 *
 * This is the cron question, and it is deliberately weaker than the per-request
 * one. `cron-runner.ts` calls `schedule.handler(ctx, runId)` once, with no firm
 * in scope - a schedule is not "for firm X" today and has no way to be. Making
 * it so would change what every existing extension's schedule means (a nightly
 * job would run once per firm), which is a product decision, not a gate. So the
 * only honest thing a gate can say here is: if no firm has this extension on,
 * do not run it at all. Per-firm cron fan-out is a documented non-goal.
 */
export async function isExtensionActiveAnywhere(db: Database, name: string): Promise<boolean> {
  try {
    const res = await sql<{ ok: boolean }>`
      SELECT true AS ok
        FROM zv_extension_registry
       WHERE name = ${name} AND is_enabled = true
       LIMIT 1
    `.execute(db);
    return res.rows.length > 0;
  } catch (err) {
    // Fails open for the same reason as the per-firm lookup.
    console.warn(`[activation] could not resolve "${name}":`, (err as Error).message);
    return true;
  }
}

function tenantIdOf(c: Context): string | null {
  const t = (c.get as (k: string) => unknown)('tenant') as { id?: unknown } | null | undefined;
  return typeof t?.id === 'string' ? t.id : null;
}

async function activeForRequest(c: Context, extName: string, db: Database): Promise<boolean> {
  const tenantId = tenantIdOf(c);
  return tenantId
    ? isExtensionActiveForTenant(db, extName, tenantId)
    : isExtensionActiveAnywhere(db, extName);
}

/**
 * `/ext/*` gate. Mount AFTER `tenantMiddleware` - it needs the resolved firm.
 *
 * A disabled extension answers exactly like an absent one. Anything else - a
 * 403, a distinct body - would tell an outsider which extensions a firm has
 * turned off, which is a fact about that firm.
 */
export function extensionActivationGate(db: Database): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const path = c.req.path;
    if (!path.startsWith('/ext/')) return next();

    const names = extensionNameCandidates(path.slice('/ext/'.length));
    if (names.length === 0) return next();

    for (const name of names) {
      if (await activeForRequest(c, name, db)) return next();
    }
    return c.json({ error: 'Not found' }, 404);
  };
}

// ── The per-extension guards ──────────────────────────────────
//
// A URL prefix is not the boundary. `mountStrategy: 'global'` — the DEFAULT —
// hands the extension the ENGINE'S OWN app and lets it register whatever paths
// it likes; `registerPublicRoute` mounts on that app too, deliberately outside
// `/ext/<name>/`. So the gate goes on the handles an extension is given, at the
// one moment its name is known.
//
// An inactive handler falls through to `next()` rather than answering. For a
// route under `/ext/` that lands on the catch-all 404 the engine already has
// for extensions that are not mounted, so a firm that switched an extension off
// sees exactly what a firm sees when it was never installed. Falling through is
// also the only safe thing to do to a middleware, which we cannot tell apart
// from a terminal handler here.

type HonoHandler = (c: Context, next: Next) => unknown;

/**
 * Is this extension active for whoever is making THIS request?
 *
 * Two questions, chosen by what the request carries, and the choice is the
 * whole design:
 *
 *   names a firm  -> is the extension on for that firm
 *   names none    -> is it on for any firm at all
 *
 * The second is not a weakening for convenience. Extension routes are not all
 * behind `tenantMiddleware`: `mountStrategy: 'global'` lets an extension pick
 * its own paths anywhere on the engine's app, and `registerPublicRoute` exists
 * precisely so an IdP can have `/scim/v2/Users` — where the bearer token IS the
 * tenant identity, so no firm can be known until the extension itself resolves
 * one. Refusing those would not enforce a firm's choice; it would delete the
 * feature. What the weaker question still guarantees is that an extension no
 * firm has turned on does not answer at all.
 */

/**
 * Gate every route of one extension's sub-app. Mounted on the sub-app itself
 * rather than on `/ext/<name>` in the parent, so it holds wherever the sub-app
 * is mounted. Answers like an extension that was never installed.
 */
export function activationMiddlewareFor(extName: string, db: Database): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (!(await activeForRequest(c, extName, db))) return c.json({ error: 'Not found' }, 404);
    return next();
  };
}

/** Wrap a route handler or middleware so it does not run for a firm that
 *  turned the extension off. */
export function guardHandler(fn: HonoHandler, extName: string, db: Database): HonoHandler {
  return async (c, next) => {
    if (!(await activeForRequest(c, extName, db))) return next();
    return fn(c, next);
  };
}

/**
 * Wrap a route registered through `registerPublicRoute`.
 *
 * These are outside `/ext/<name>/` by design and, unlike every other route, may
 * legitimately arrive with no firm named: SCIM's bearer token IS the tenant
 * identity, so the token lookup necessarily happens before a tenant can be
 * resolved. Refusing those would break the feature the escape hatch exists for.
 *
 * So the question asked depends on what the request carries. Names a firm: is
 * the extension on for that firm. Names none: is it on for any firm at all —
 * the same weaker question cron is asked, and for the same reason. A firm
 * cannot switch off another firm's tenant-less public route, and nobody can
 * reach one belonging to an extension that is off everywhere.
 */
export function guardPublicHandler(fn: HonoHandler, extName: string, db: Database): HonoHandler {
  return async (c, next) => {
    if (!(await activeForRequest(c, extName, db))) return next();
    return fn(c, next);
  };
}

/** Route-registering methods on a Hono app. `on` takes (method, path, …). */
const ROUTE_METHODS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'all',
  'use',
  'on',
]);

/**
 * Hand an extension a view of the app whose registrations are gated.
 *
 * Every handler passed through a route method is wrapped, so it does not matter
 * what path the extension chooses. `route()` and `mount()` are deliberately NOT
 * wrapped: they attach a whole sub-router whose handlers never pass through
 * this proxy. Extensions that mount a sub-app get the gate from the `use('*')`
 * their subapp is given at mount time instead.
 */
export function guardExtensionApp<T extends object>(app: T, extName: string, db: Database): T {
  const proxy: T = new Proxy(app, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      // Bind so Hono's methods keep their `this`; a bare reference would lose it
      // the moment the extension destructures one.
      if (typeof prop !== 'string' || !ROUTE_METHODS.has(prop)) return orig.bind(target);
      return (...args: unknown[]) => {
        const wrapped = args.map((a) =>
          typeof a === 'function' ? guardHandler(a as HonoHandler, extName, db) : a,
        );
        const out = (orig as (...a: unknown[]) => unknown).apply(target, wrapped);
        // Hono chains by returning the app itself. Return the proxy instead, or
        // `app.get(…).post(…)` would register the second route unguarded.
        return out === target ? proxy : out;
      };
    },
  }) as T;
  return proxy;
}

/**
 * Wrap an event listener an extension registered.
 *
 * Gated on the ambient domain, which is the firm whose request or job is being
 * served. Outside any tenant store — boot, CLI — `getCurrentDomain()` reports
 * the default firm and cannot be told apart from genuinely serving it, so a
 * listener is judged against the default firm there. That is the one place this
 * gate answers a slightly different question than it was asked.
 */
export function guardEventHandler<A extends unknown[]>(
  fn: (...args: A) => unknown,
  extName: string,
  db: Database,
): (...args: A) => unknown {
  return async (...args: A) => {
    if (!(await isExtensionActiveForTenant(db, extName, getCurrentDomain()))) return undefined;
    return fn(...args);
  };
}

/**
 * Wrap a cron handler. Gated on `isExtensionActiveAnywhere` — see that function
 * for why a schedule cannot be asked the per-firm question.
 */
export function guardScheduleHandler<A extends unknown[]>(
  fn: (...args: A) => unknown,
  extName: string,
  db: Database,
): (...args: A) => unknown {
  return async (...args: A) => {
    if (!(await isExtensionActiveAnywhere(db, extName))) return undefined;
    return fn(...args);
  };
}

/**
 * Wrap whichever argument of an `events.on(...)` call is the listener.
 *
 * The bus takes `(event, handler)` and `(event, opts, handler)` depending on
 * the overload, and the wrapper that tracks unsubscribes forwards its arguments
 * untouched — so the listener is found by shape rather than by position.
 */
export function guardListenerArgs<A extends unknown[]>(args: A, extName: string, db: Database): A {
  return args.map((a) =>
    typeof a === 'function'
      ? guardEventHandler(a as (...rest: unknown[]) => unknown, extName, db)
      : a,
  ) as A;
}
