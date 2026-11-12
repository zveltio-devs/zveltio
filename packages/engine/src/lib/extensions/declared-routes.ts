/**
 * ADR 0039: a route is declared in the manifest and answered by a plain function.
 *
 * The manifest names method, path, access and handler; the module exports the
 * handler under `routes[handler]`, `(request, { params, host }) => Response`.
 * The engine mounts each declared route itself, so its HTTP layer — the `/ext/*`
 * gate (`access`), tenant, body limit, rate limit — is the one every extension
 * route already passes through, and path parameters are the engine's matcher's.
 *
 * Shared by both transports: `register.ts` mounts the routes on an inline
 * extension's sub-app, and the worker runtime (`worker-extension-runtime.ts`)
 * on the app it serves the host's proxy from, since only the worker imports a
 * worker-isolated module. Hono types only: this file is bundled into the worker.
 */

import type { Context, Hono } from 'hono';
import type { DeclaredRouteHost, RouteHandler } from '@zveltio/sdk/extension';

/** A manifest `routes` entry, as far as mounting needs it (`access` is the gate's). */
export interface RouteSpec {
  method: string;
  path: string;
  handler: string;
}

export interface DeclaredRoute extends RouteSpec {
  run: RouteHandler;
}

/**
 * Pair the declared routes with the module's handlers. Throws — refusing the
 * load — when a route names a handler the module does not export, or the module
 * exports one no route names, as for actions and jobs.
 */
export function pairRouteHandlers(
  declared: readonly RouteSpec[],
  implemented: Record<string, unknown> | undefined,
  refuse: (why: string) => never,
): DeclaredRoute[] {
  const handlers = implemented ?? {};
  const out = declared.map((r) => {
    const run = Object.hasOwn(handlers, r.handler) ? handlers[r.handler] : undefined;
    if (typeof run !== 'function') {
      refuse(`manifest route ${r.method} ${r.path} names handler "${r.handler}", which routes does not export`);
    }
    return { method: r.method, path: r.path, handler: r.handler, run: run as RouteHandler };
  });
  for (const name of Object.keys(handlers)) {
    if (!declared.some((r) => r.handler === name)) {
      refuse(`route handler "${name}" is exported but no manifest route names it`);
    }
  }
  return out;
}

/**
 * Mount `routes` on `app`. Call before the extension's own `register()`, so a
 * `use('*')` it adds never runs for a declared route. `request` is what the
 * handler receives: the raw request inline, the caller's URL in a worker.
 */
export function mountDeclaredRoutes(
  app: Hono,
  routes: readonly DeclaredRoute[],
  host: (c: Context) => DeclaredRouteHost,
  request: (c: Context) => Request = (c) => c.req.raw,
): void {
  for (const r of routes) {
    app.on(r.method, r.path, async (c) => {
      const res = await r.run(request(c), { params: c.req.param() as Record<string, string>, host: host(c) });
      if (!(res instanceof Response)) {
        throw new Error(`route ${r.method} ${r.path}: handler "${r.handler}" did not return a Response`);
      }
      return res;
    });
  }
}
