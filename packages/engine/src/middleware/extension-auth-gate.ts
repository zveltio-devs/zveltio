/**
 * Fail-closed authentication gate for extension routes (`/ext/*`).
 *
 * Historically `/ext/*` had NO engine-level auth: each extension defended its
 * own routes with an inline `auth.api.getSession(...)` check. That is fail-OPEN
 * — a route whose author forgot the check is reachable anonymously, and nothing
 * catches it. Real holes shipped this way (postgis geofences, the Twilio and
 * SMS status webhooks, geofence writes) and were only found by audit.
 *
 * This gate inverts the default: a request under `/ext/<name>/*` must carry a
 * valid session UNLESS the owning extension's manifest declares that sub-path in
 * `publicRoutes`. So a forgotten guard now yields 401 (safe) instead of silent
 * exposure. Authorization stays the extension's job — this only enforces
 * AUTHENTICATION; `permissionGate(ctx, name)` still does per-resource RBAC.
 *
 * API keys: a route the manifest declares in `apiKeyRoutes` (`"POST /invoices"`)
 * also admits a key holding `$ext:<name>` for the method's action — GET read,
 * POST create, PUT/PATCH update, DELETE delete, as `permissionGate` derives it.
 * A declared action (`POST /actions/<action>`) admits a key holding `$ext:<name>`
 * for the action's own permission action (`execute` by default) — never `create`,
 * which would open every POST route the extension declares for keys.
 * The key principal is set as `user` and, for the rest of the request,
 * `admittedApiKey()` answers the extension's `ctx.checkPermission` from that
 * scope instead of Casbin (lib/extensions/register.ts). Every other route
 * refuses a key exactly as before: 403 EXT_SESSION_REQUIRED.
 *
 * There is no switch to turn it off: a route meant to be anonymous is declared
 * in the manifest's `publicRoutes`, per route and visible in review.
 *
 * Not covered: routes an extension mounts on the GLOBAL app via
 * `ctx.registerPublicRoute` (they live outside `/ext/<name>`). Those are public
 * by construction; the extensions-repo CI guard flags any that shouldn't be.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Database } from '../db/index.js';
import { guardSessionOrKey, presentsUsableKey, refuseWithoutSession } from '../lib/admin-guard.js';
import { apiKeyHoldsScope, extScope, isApiKeyPrincipal, requestApiKey } from '../lib/data/index.js';
import type { RequestUser } from '../lib/data/index.js';
import { requireConfigWindow } from '../lib/step-up.js';
import { principalRole } from '../lib/tenancy/index.js';
import { mutates } from './config-routes.js';
import { offConsoleHost } from './console-host.js';
import { requestSession } from './session-prefetch.js';

/**
 * Minimal structural view of the better-auth instance this gate needs — just
 * `getSession`. Sibling middleware (tenant-membership) takes `auth: any`; a
 * narrow interface documents the actual dependency without importing the whole
 * better-auth type surface. The `user` shape mirrors `RequestUser` (lib/data)
 * structurally so `c.set('user', …)` type-checks without a cross-subsystem
 * deep import (enforced by scripts/import-boundaries.ts).
 */
interface SessionResolver {
  api: {
    getSession(args: {
      headers: Headers;
    }): Promise<{ user?: { id: string; name: string; role: string; email?: string } } | null>;
  };
}

interface KeyRoute {
  method: string;
  path: RegExp;
  action: string;
}

/** A manifest `routes` entry (ADR 0039), compiled: its access is decided by method and path. */
interface DeclaredRoute {
  method: string;
  path: RegExp;
  public: boolean;
}

/** Registered extension → its compiled public-route and API-key-route matchers. */
const registry = new Map<
  string,
  { publicRoutes: RegExp[]; apiKeyRoutes: KeyRoute[]; routes: DeclaredRoute[] }
>();

/** `POST /actions/<name>`: the engine's action route, mounted ahead of every declared route. */
const ACTION_ROUTE = /^\/actions\/[^/]+$/;

/** The action `permissionGate` derives from a method — the one a key's scope must carry. */
const METHOD_ACTION: Record<string, string> = {
  GET: 'read',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/** A manifest `apiKeyRoutes` entry, `"<METHOD> <pattern>"` (validated by the manifest schema). */
function compileKeyRoute(entry: string): KeyRoute {
  const [method = '', pattern = '', extra] = entry.split(' ');
  const action = METHOD_ACTION[method];
  // The schema refuses a malformed entry; one that got here anyway opens nothing.
  if (!action || !pattern || extra !== undefined) return { method: '', path: /$^/, action: '' };
  return { method, path: compilePattern(pattern), action };
}

/**
 * The key principal the gate admitted for this request, if any. An extension's
 * `ctx.checkPermission` answers an `apikey:` id from this and never from Casbin,
 * which holds no policy for a key and would refuse it on every call.
 */
const admitted = new AsyncLocalStorage<AdmittedKey>();

/** The key the gate admitted: its id, its scopes and the person who issued it. */
interface AdmittedKey {
  id: string;
  scopes: unknown;
  authorUserId: string | null;
}

export function admittedApiKey(): AdmittedKey | undefined {
  return admitted.getStore();
}

/**
 * Run `fn` with `user`, when it is a key, as the admitted key — for a check made
 * for a principal the engine itself authenticated: the gate's, the action route's
 * and `GET /api/actions`' (`mayRunAction`). Never for an id extension code chose.
 */
export function asAdmittedKey<T>(user: RequestUser, fn: () => Promise<T>): Promise<T> {
  if (!isApiKeyPrincipal(user)) return fn();
  const key = { id: user.id, scopes: user.scopes, authorUserId: user.authorUserId ?? null };
  return admitted.run(key, fn);
}

/**
 * Who the gate admitted, as the gate saw it: what the write members of
 * `ctx.internals` act as (`gatePrincipal`).
 *
 * Not `c.get('user')`: the extension holds `c`, and `c.set` or a mutation of the
 * object it returns would make it someone else. So the identity, its kind, the
 * request's transaction and its tenant are copied here, before any extension
 * code runs, and bound to the context object and to this request's async scope.
 */
export interface GatePrincipal {
  user: RequestUser;
  authType: 'session' | 'api_key';
  trx: Database | undefined;
  tenantId: string | null;
}

const gated = new AsyncLocalStorage<{ c: Context; principal: GatePrincipal }>();

async function runAdmitted(
  c: Context,
  user: RequestUser,
  next: () => Promise<void>,
): Promise<void> {
  const principal: GatePrincipal = {
    // With the role `authenticate` gives a REST caller: an extension's write
    // runs the same extension gates, and a session user here carries none.
    user: { ...structuredClone(user), role: await principalRole(user.id) },
    authType: isApiKeyPrincipal(user) ? 'api_key' : 'session',
    trx: c.get('tenantTrx') ?? undefined,
    tenantId: c.get('tenant')?.id ?? null,
  };
  return gated.run({ c, principal }, next);
}

/**
 * The principal the gate admitted for `c` — only while `c`'s own request is the
 * one running, so a context kept from another request, a forged object, a job
 * or a listener outside any request all get `undefined`.
 */
export function gatePrincipal(c: unknown): GatePrincipal | undefined {
  const store = gated.getStore();
  return store && store.c === c ? store.principal : undefined;
}

/**
 * The context of the `/ext/*` request running now, named by itself or by its
 * `Request`: a declared route's handler is handed the request, never `c` (ADR
 * 0039), and the `ctx.internals` members that act for "the request being
 * handled" take it in `c`'s place. Anything else comes back as it came, so a
 * request kept from an earlier call, or a forged object, still names no caller.
 */
export function servedContext(token: unknown): unknown {
  for (const store of [gated.getStore(), publicServed.getStore()]) {
    if (store && (store.c === token || store.c.req.raw === token)) return store.c;
  }
  return token;
}

/**
 * A request the gate let through as one of an extension's `publicRoutes`: who
 * owns the route, the sub-path it matched, and the request's transaction and
 * tenant, copied before extension code runs (as `GatePrincipal`).
 * `ctx.internals.enqueue` acts only inside one (ADR 0018).
 */
export interface PublicRouteRequest {
  extName: string;
  sub: string;
  trx: Database | undefined;
  tenantId: string | null;
}

const publicServed = new AsyncLocalStorage<{ c: Context; req: PublicRouteRequest }>();

/** The public-route request being served for `c`, as `gatePrincipal`: `undefined` for any other `c`. */
export function publicRouteRequest(c: unknown): PublicRouteRequest | undefined {
  const store = publicServed.getStore();
  return store && store.c === c ? store.req : undefined;
}

/**
 * An extension's `ctx.checkPermission`, answering an API key from its scope.
 *
 * Casbin holds no policy for `apikey:<uuid>`, so asking it refused every key
 * the gate had just admitted — `permissionGate` would 403 each `apiKeyRoutes`
 * route. A key is answered by `$ext:<extName>` for the asked action, and only
 * while it is the key this gate admitted for this request (the scope is per
 * extension) — AND by `base` asking the key's issuer for the resource itself: a
 * key never exceeds the person it acts for, so a demoted issuer's key loses what
 * they lost. Outside such a request (a job, a listener after the response) a key
 * id is refused. Sessions: unchanged.
 */
export function keyAwareCheckPermission(
  extName: string,
  base: (userId: string, resource: string, action: string) => Promise<boolean>,
): (userId: string, resource: string, action: string) => Promise<boolean> {
  const check = async (userId: string, resource: string, action: string) => {
    if (!isApiKeyPrincipal({ id: userId })) return base(userId, resource, action);
    const key = admittedApiKey();
    if (key?.id !== userId || !apiKeyHoldsScope(key.scopes, extScope(extName), action))
      return false;
    return !!key.authorUserId && base(key.authorUserId, resource, action);
  };
  return async (userId, resource, action) => {
    const granted = await check(userId, resource, action);
    return resource === 'admin' ? fenceAdminGrant(granted) : granted;
  };
}

/**
 * The extension request being served — `/ext/*`, or a route an extension put on
 * the global app — and the configuration refusal an `admin` check recorded for it.
 */
const extRequest = new AsyncLocalStorage<{
  c: Context;
  auth: SessionResolver;
  refusal?: Response;
}>();

/**
 * Serve `c` as an extension request. When an `admin` check refused it for want
 * of the configuration window, the request answers that refusal and rolls back,
 * whatever the extension did with the throw: one that caught it and answered
 * its own 403 hid the `step_up_required` the Console steps up on, and a worker
 * only ever sees the throw as an error.
 */
export async function runExtensionRequest<R>(
  c: Context,
  auth: SessionResolver,
  serve: () => Promise<R>,
): Promise<R | Response> {
  const store: { c: Context; auth: SessionResolver; refusal?: Response } = { c, auth };
  const res = await extRequest.run(store, serve);
  if (!store.refusal) return res;
  // `tenantMiddleware` rolls the request back on `c.error` and keeps `c.res`.
  c.error ??= new HTTPException(403, { message: 'configuration window required' });
  c.res = store.refusal;
  return c.res;
}

/** Did an `admin` check refuse the extension request being served? */
export function extensionRequestRefused(): boolean {
  return !!extRequest.getStore()?.refusal;
}

/**
 * An extension request is configuration when it mutates and is authorized
 * against the `admin` object, so a grant of `admin` to a mutating extension
 * request also needs the session's step-up window, as an `/api/*` configuration
 * mutation does (`configStepUp`): no window, no session (an API key) — refused
 * with the same answer, thrown so no caller reads it as a grant. A refusal of
 * `admin` stays a refusal, so a user who is no administrator is never asked to
 * step up. Off the console host (`ZVELTIO_CONSOLE_HOST`) it is refused 404, as
 * `/api/*` configuration is there. Outside an extension request, and on a read,
 * the grant is unchanged.
 */
export async function fenceAdminGrant(granted: boolean): Promise<boolean> {
  const store = extRequest.getStore();
  if (!granted || !store || !mutates(store.c.req.method)) return granted;
  if (!store.refusal) {
    const session = await requestSession(store.c, store.auth);
    const refusal =
      offConsoleHost(store.c) ??
      (session ? await requireConfigWindow(store.c, session) : await refuseWithoutSession(store.c));
    if (!refusal) return true;
    store.refusal = refusal;
  }
  throw new HTTPException(403, { res: store.refusal.clone() });
}

/**
 * Compile a manifest publicRoutes pattern into an anchored RegExp.
 *
 * `*` becomes `.*` (matches across `/`); a `:param` segment (a declared route's,
 * ADR 0039) matches one segment; every literal chunk is regex-escaped.
 * A leading slash is optional in the declaration — normalized so both
 * `"/public/*"` and `"public/*"` work. Patterns are matched against the
 * sub-path AFTER the `/ext/<name>` mount (which always starts with `/`).
 */
export function compilePattern(pattern: string): RegExp {
  const normalized = pattern.startsWith('/') ? pattern : `/${pattern}`;
  // Split on '*' so each literal chunk is regex-escaped independently, then
  // rejoin with '.*' (the wildcard matches across '/'). No placeholder char.
  const body = normalized
    .split('*')
    .map((chunk) =>
      chunk
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/(?<=\/):[A-Za-z_][A-Za-z0-9_]*(?=\/|$)/g, '[^/]+'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Record an extension's declared public and API-key routes. Called by the
 * loader on each (re)load. Idempotent — a reload replaces the previous set. An
 * empty/omitted list means "every route under this extension requires a session".
 */
export function registerExtensionPublicRoutes(
  extName: string,
  publicRoutes: readonly string[],
  apiKeyRoutes: readonly string[] = [],
  actions: Iterable<{ name: string; permission: { action: string } }> = [],
  routes: readonly { method: string; path: string; access: string }[] = [],
): void {
  // Actions first: `keyRouteAction` takes the first match, and an `apiKeyRoutes`
  // `POST /actions/*` must not turn the action's gate back into `create`.
  const actionRoutes = [...actions].map((a) => ({
    method: 'POST',
    path: compilePattern(`/actions/${a.name}`),
    action: a.permission.action,
  }));
  registry.set(extName, {
    publicRoutes: publicRoutes.map(compilePattern),
    apiKeyRoutes: [...actionRoutes, ...apiKeyRoutes.map(compileKeyRoute)],
    routes: routes.map((r) => ({
      method: r.method,
      path: compilePattern(r.path),
      public: r.access === 'public',
    })),
  });
}

/** Drop an extension's entry (on unload). Safe to call for an unknown name. */
export function unregisterExtensionPublicRoutes(extName: string): void {
  registry.delete(extName);
}

/** Test seam: wipe the registry between test files. */
export function _resetPublicRouteRegistryForTests(): void {
  registry.clear();
}

/**
 * Given the path after `/ext/`, find the registered extension whose name is a
 * segment-aligned prefix of it, preferring the LONGEST match (so `content/pdf`
 * wins over `content`). Returns the name + the remaining sub-path (leading `/`),
 * or null if no registered extension owns the path.
 */
function resolveOwner(rest: string): { name: string; sub: string } | null {
  let best: { name: string; sub: string } | null = null;
  for (const name of registry.keys()) {
    if (rest === name) {
      // Exact mount hit with no sub-path — treat as root "/".
      if (!best || name.length > best.name.length) best = { name, sub: '/' };
    } else if (rest.startsWith(`${name}/`)) {
      const candidate = { name, sub: rest.slice(name.length) };
      if (!best || name.length > best.name.length) best = candidate;
    }
  }
  return best;
}

/**
 * True if `method sub` is served without a session. A declared route decides by
 * the route the request resolves to — the first that matches method and path,
 * in manifest order, as the routes are mounted — so a public pattern opens no
 * other method of its path and no `caller` route of its shape. The action route
 * is mounted before them and is never a declared route's. Otherwise the
 * deprecated `publicRoutes`, by path.
 */
function isDeclaredPublic(extName: string, method: string, sub: string): boolean {
  const entry = registry.get(extName);
  if (!entry) return false;
  // Hono answers HEAD with the GET route.
  const m = method === 'HEAD' ? 'GET' : method;
  if (!(m === 'POST' && ACTION_ROUTE.test(sub))) {
    const route = entry.routes.find((r) => r.method === m && r.path.test(sub));
    if (route) return route.public;
  }
  return entry.publicRoutes.some((re) => re.test(sub));
}

/** The action a key needs for `method sub`, or null when the route is not declared for keys. */
function keyRouteAction(extName: string, method: string, sub: string): string | null {
  const route = registry
    .get(extName)
    ?.apiKeyRoutes.find((r) => r.method === method && r.path.test(sub));
  return route?.action ?? null;
}

/**
 * Would this gate let `user` reach `POST /ext/<extName>/actions/<name>` as a
 * principal: the path is the extension's, it is not declared public (served with
 * no principal, the action route refuses everyone), and a key holds `$ext:<extName>`
 * for the action the route needs. A session passes, as below. Only `mayRunAction`
 * asks it.
 */
export function gateAdmitsAction(extName: string, name: string, user: RequestUser): boolean {
  const owner = resolveOwner(`${extName}/actions/${name}`);
  if (owner?.name !== extName || isDeclaredPublic(extName, 'POST', owner.sub)) return false;
  if (!isApiKeyPrincipal(user)) return true;
  const action = keyRouteAction(extName, 'POST', owner.sub);
  return !!action && apiKeyHoldsScope(user.scopes, extScope(extName), action);
}

/**
 * Build the `/ext/*` gate. Mount AFTER tenant middleware and BEFORE the
 * extension subapps so it wraps every extension route.
 */
export function extensionAuthGate(auth: SessionResolver, db: Database): MiddlewareHandler {
  const gate: MiddlewareHandler = async (c: Context, next) => {
    // CORS preflight carries no credentials — never gate it.
    if (c.req.method === 'OPTIONS') return next();

    const path = c.req.path;
    if (!path.startsWith('/ext/')) return next();
    const rest = path.slice('/ext/'.length);

    const owner = resolveOwner(rest);
    if (owner && isDeclaredPublic(owner.name, c.req.method, owner.sub)) {
      // Explicitly declared public — anonymous access allowed.
      const req: PublicRouteRequest = {
        extName: owner.name,
        sub: owner.sub,
        trx: c.get('tenantTrx') ?? undefined,
        tenantId: c.get('tenant')?.id ?? null,
      };
      return publicServed.run({ c, req }, next);
    }

    // A route declared for keys, and a key presented: the key model of every
    // other surface (`guardSessionOrKey`) — 401 invalid/foreign, 403 no scope.
    const action = owner && keyRouteAction(owner.name, c.req.method, owner.sub);
    if (owner && action && requestApiKey(c)) {
      const user = await guardSessionOrKey(c, auth, db, extScope(owner.name), action);
      if (user instanceof Response) return user;
      c.set('user', user);
      // A session sent alongside the key wins, as it does in `authenticate`.
      return asAdmittedKey(user, () => runAdmitted(c, user, next));
    }

    // Fail-closed: require an authenticated session.
    const session = await requestSession(c, auth).catch(() => null);
    if (!session?.user) {
      // A valid key of this tenant is somebody: refuse it with 403, never 401 —
      // the SDK signs its client out on every 401 (see `refuseWithoutSession`).
      if (await presentsUsableKey(c)) {
        return c.json(
          {
            error: 'Session required',
            code: 'EXT_SESSION_REQUIRED',
            detail: 'This extension route requires a signed-in session; an API key cannot use it.',
          },
          403,
        );
      }
      return c.json(
        {
          error: 'Unauthorized',
          code: 'EXT_AUTH_REQUIRED',
          detail:
            'This extension route requires an authenticated session. If it is meant ' +
            'to be public, declare it in the extension manifest `publicRoutes`.',
        },
        401,
      );
    }
    // Expose the resolved user so extension handlers can reuse it instead of a
    // second getSession round-trip (they may still call getSession themselves).
    c.set('user', session.user);
    return runAdmitted(c, session.user as RequestUser, next);
  };
  return (c, next) => runExtensionRequest(c, auth, async () => gate(c, next));
}
