/**
 * Server-side rendering of the public web host (ADR 0005).
 *
 * `packages/client` builds with an in-repo adapter that writes, next to the
 * static files, `_server/entry.js`: a SvelteKit server instance. The engine
 * imports it and renders public pages in its own process, so there is one
 * process, one origin and one session cookie. Off unless
 * `ZVELTIO_CLIENT_SSR=1`; the caller falls back to the SPA shell whenever this
 * returns null.
 */
import { join, sep } from 'path';
import type { Context } from 'hono';
import { resolveClientIp } from './security/index.js';

interface KitServer {
  init(opts: {
    env: Record<string, string>;
    read: (file: string) => ReadableStream;
  }): Promise<void>;
  respond(
    request: Request,
    opts: {
      getClientAddress(): string;
      platform: { engineFetch(request: Request): Promise<Response> };
    },
  ): Promise<Response>;
}

type AppFetch = (request: Request, env: unknown) => Response | Promise<Response>;

/** The paths a server-side `load` may reach in-process. Both end in a JSON 404 guard, never in this renderer. */
const ENGINE_PATH = /^\/(api|ext)\//;

/** The visitor's credentials and address, which a server-side `load` acts with and cannot replace. */
const VISITOR_HEADERS = ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip'];

const servers = new Map<string, Promise<KitServer | null>>();

/**
 * Whether `resolved` (an absolute path already resolved inside `root`) is the
 * server bundle or a file in it. The bundle sits inside the client dist, so the
 * static server must refuse it. Checked on the resolved path, so no encoding or
 * `..` reaches it; folded on the case-insensitive file systems of macOS and
 * Windows.
 */
export function isServerBundlePath(root: string, resolved: string): boolean {
  const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
  const bundle = fold(join(root, '_server'));
  const path = fold(resolved);
  return path === bundle || path.startsWith(bundle + sep);
}

export function clientSsrEnabled(): boolean {
  return process.env.ZVELTIO_CLIENT_SSR === '1';
}

/** Loaded once per dist root. A bundle that is missing or fails to start stays off until restart. */
function loadServer(distRoot: string): Promise<KitServer | null> {
  let server = servers.get(distRoot);
  if (!server) {
    server = (async () => {
      const entry = join(distRoot, '_server', 'entry.js');
      if (!(await Bun.file(entry).exists())) return null;
      const instance = ((await import(entry)) as { server: KitServer }).server;
      // Only browser-visible variables: the render must not be able to read
      // the engine's secrets through `$env/dynamic/private`.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith('PUBLIC_') && v !== undefined) env[k] = v;
      }
      await instance.init({ env, read: (file) => Bun.file(join(distRoot, file)).stream() });
      return instance;
    })().catch((err) => {
      console.error('[client-ssr] server bundle failed to start; serving the SPA shell:', err);
      return null;
    });
    servers.set(distRoot, server);
  }
  return server;
}

/**
 * Render the request, or return null so the caller serves the SPA shell.
 *
 * A `load` that calls `/api/*` or `/ext/*` on this origin is answered by
 * `appFetch` in-process, always with the visitor's own cookie, authorization
 * and address, so a server render never has more rights than the visitor.
 */
export async function renderClient(
  c: Context,
  distRoot: string,
  appFetch: AppFetch,
): Promise<Response | null> {
  const server = await loadServer(distRoot);
  if (!server) return null;

  const outer = c.req.raw;
  const outerEnv = c.env as { server?: { requestIP?(r: Request): unknown } } | undefined;
  // The client-ip resolver asks the Bun server for the peer of the request it
  // sees; a synthetic request has none, so answer with the visitor's.
  const subEnv = { server: { requestIP: () => outerEnv?.server?.requestIP?.(outer) ?? null } };

  const engineFetch = async (request: Request): Promise<Response> => {
    if (!ENGINE_PATH.test(new URL(request.url).pathname)) {
      return new Response(null, { status: 404 });
    }
    const headers = new Headers(request.headers);
    for (const name of VISITOR_HEADERS) {
      const value = outer.headers.get(name);
      if (value) headers.set(name, value);
      else headers.delete(name);
    }
    return appFetch(new Request(request, { headers }), subEnv);
  };

  try {
    const res = await server.respond(outer, {
      getClientAddress: () => resolveClientIp(c),
      platform: { engineFetch },
    });
    // A failed render is a page the SPA may still be able to show.
    if (res.status >= 500) return null;
    // Read here, so a body that fails mid-stream still falls back.
    const out = new Response(res.body ? await res.arrayBuffer() : null, res);
    // Every rendered response (page, `__data.json`, redirect) carries this
    // visitor's data: no shared cache may store it.
    out.headers.set('Cache-Control', 'private, no-store');
    return out;
  } catch (err) {
    console.error('[client-ssr] render failed; serving the SPA shell:', err);
    return null;
  }
}
