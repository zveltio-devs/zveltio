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
 * Escape hatch: `ZVELTIO_EXT_AUTH_GATE=0` disables it (operational safety valve
 * for an install whose extension manifests predate their publicRoutes
 * declarations). Default is on.
 *
 * Not covered: routes an extension mounts on the GLOBAL app via
 * `ctx.registerPublicRoute` (they live outside `/ext/<name>`). Those are public
 * by construction; the extensions-repo CI guard flags any that shouldn't be.
 */

import type { Context, MiddlewareHandler } from 'hono';

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

/** Registered extension → its compiled public-route matchers. */
const registry = new Map<string, RegExp[]>();

/**
 * Compile a manifest publicRoutes pattern into an anchored RegExp.
 *
 * `*` becomes `.*` (matches across `/`); every literal chunk is regex-escaped.
 * A leading slash is optional in the declaration — normalized so both
 * `"/public/*"` and `"public/*"` work. Patterns are matched against the
 * sub-path AFTER the `/ext/<name>` mount (which always starts with `/`).
 */
function compilePattern(pattern: string): RegExp {
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
 * Record an extension's declared public routes. Called by the loader on each
 * (re)load. Idempotent — a reload replaces the previous set. An empty/omitted
 * list means "every route under this extension requires a session".
 */
export function registerExtensionPublicRoutes(
  extName: string,
  publicRoutes: readonly string[],
): void {
  registry.set(extName, publicRoutes.map(compilePattern));
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
  const matchers = registry.get(extName);
  if (!matchers) return false;
  return matchers.some((re) => re.test(sub));
}

/**
 * Build the `/ext/*` gate. Mount AFTER tenant middleware and BEFORE the
 * extension subapps so it wraps every extension route.
 */
export function extensionAuthGate(auth: SessionResolver): MiddlewareHandler {
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

    // Fail-closed: require an authenticated session.
    const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    if (!session?.user) {
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
    return next();
  };
}
