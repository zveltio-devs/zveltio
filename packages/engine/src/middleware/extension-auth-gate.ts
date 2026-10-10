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
 * The key principal is set as `user` and, for the rest of the request,
 * `admittedApiKey()` answers the extension's `ctx.checkPermission` from that
 * scope instead of Casbin (lib/extensions/register.ts). Every other route
 * refuses a key exactly as before: 403 EXT_SESSION_REQUIRED.
 *
 * Escape hatch: `ZVELTIO_EXT_AUTH_GATE=0` disables it (operational safety valve
 * for an install whose extension manifests predate their publicRoutes
 * declarations). Default is on.
 *
 * Not covered: routes an extension mounts on the GLOBAL app via
 * `ctx.registerPublicRoute` (they live outside `/ext/<name>`). Those are public
 * by construction; the extensions-repo CI guard flags any that shouldn't be.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, MiddlewareHandler } from 'hono';
import type { Database } from '../db/index.js';
import { guardSessionOrKey, presentsUsableKey } from '../lib/admin-guard.js';
import { apiKeyHoldsScope, extScope, isApiKeyPrincipal, requestApiKey } from '../lib/data/index.js';
import type { RequestUser } from '../lib/data/index.js';
import { principalRole } from '../lib/tenancy/index.js';
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

/** Registered extension → its compiled public-route and API-key-route matchers. */
const registry = new Map<string, { publicRoutes: RegExp[]; apiKeyRoutes: KeyRoute[] }>();

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
const admitted = new AsyncLocalStorage<{ id: string; scopes: unknown }>();

export function admittedApiKey(): { id: string; scopes: unknown } | undefined {
  return admitted.getStore();
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
 * An extension's `ctx.checkPermission`, answering an API key from its scope.
 *
 * Casbin holds no policy for `apikey:<uuid>`, so asking it refused every key
 * the gate had just admitted — `permissionGate` would 403 each `apiKeyRoutes`
 * route. A key is answered by `$ext:<extName>` for the asked action, and only
 * while it is the key this gate admitted for this request; the resource
 * is not consulted — the scope is per extension. Outside such a request (a job,
 * a listener after the response) a key id is refused. Sessions: unchanged.
 */
export function keyAwareCheckPermission(
  extName: string,
  base: (userId: string, resource: string, action: string) => Promise<boolean>,
): (userId: string, resource: string, action: string) => Promise<boolean> {
  return async (userId, resource, action) => {
    if (!isApiKeyPrincipal({ id: userId })) return base(userId, resource, action);
    const key = admittedApiKey();
    return key?.id === userId && apiKeyHoldsScope(key.scopes, extScope(extName), action);
  };
}

/**
 * Compile a manifest publicRoutes pattern into an anchored RegExp.
 *
 * `*` becomes `.*` (matches across `/`); every literal chunk is regex-escaped.
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
    .map((chunk) => chunk.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
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
): void {
  registry.set(extName, {
    publicRoutes: publicRoutes.map(compilePattern),
    apiKeyRoutes: apiKeyRoutes.map(compileKeyRoute),
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

/** True if `sub` matches any of the extension's declared public patterns. */
function isDeclaredPublic(extName: string, sub: string): boolean {
  const matchers = registry.get(extName)?.publicRoutes;
  if (!matchers) return false;
  return matchers.some((re) => re.test(sub));
}

/** The action a key needs for `method sub`, or null when the route is not declared for keys. */
function keyRouteAction(extName: string, method: string, sub: string): string | null {
  const route = registry
    .get(extName)
    ?.apiKeyRoutes.find((r) => r.method === method && r.path.test(sub));
  return route?.action ?? null;
}

/**
 * Build the `/ext/*` gate. Mount AFTER tenant middleware and BEFORE the
 * extension subapps so it wraps every extension route.
 */
export function extensionAuthGate(auth: SessionResolver, db: Database): MiddlewareHandler {
  return async (c: Context, next) => {
    if (process.env.ZVELTIO_EXT_AUTH_GATE === '0') return next();
    // CORS preflight carries no credentials — never gate it.
    if (c.req.method === 'OPTIONS') return next();

    const path = c.req.path;
    if (!path.startsWith('/ext/')) return next();
    const rest = path.slice('/ext/'.length);

    const owner = resolveOwner(rest);
    if (owner && isDeclaredPublic(owner.name, owner.sub)) {
      // Explicitly declared public — anonymous access allowed.
      return next();
    }

    // A route declared for keys, and a key presented: the key model of every
    // other surface (`guardSessionOrKey`) — 401 invalid/foreign, 403 no scope.
    const action = owner && keyRouteAction(owner.name, c.req.method, owner.sub);
    if (owner && action && requestApiKey(c)) {
      const user = await guardSessionOrKey(c, auth, db, extScope(owner.name), action);
      if (user instanceof Response) return user;
      c.set('user', user);
      // A session sent alongside the key wins, as it does in `authenticate`.
      if (!isApiKeyPrincipal(user)) return runAdmitted(c, user, next);
      return admitted.run({ id: user.id, scopes: user.scopes }, () => runAdmitted(c, user, next));
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
}
