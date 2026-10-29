/**
 * The Console fenced by host (`ZVELTIO_CONSOLE_HOST`, e.g. `admin.example.com`).
 *
 * The Console and the App share an origin by default, so an XSS in the App
 * against a signed-in administrator can call the configuration API. With the
 * variable set, the Console (`/admin`), `/api/admin/*`, every configuration
 * mutation (`isConfigMutation`), the CLI's browser confirmation (`/api/auth/cli/*`)
 * and every extension mutation authorized against `admin` (`fenceAdminGrant`)
 * answer only on that host, 404 elsewhere; the rest
 * answers on every host. Unset, nothing changes.
 *
 * The session cookie is host-only already (better-auth sets no Domain), so a
 * Console session lives on the console host and an App session on the main host,
 * each in its own cookie jar under the same name. Host-only is not enough on its
 * own: the two hosts are same-site, so SameSite=Lax still attaches the Console's
 * cookie to a request a script on the main domain sends to the console host. The
 * console host therefore refuses any request whose `Origin` names another host
 * (browsers send it on every cross-origin request and every non-GET one).
 *
 * The host is the request's `Host`, as tenant resolution reads it: the engine
 * trusts no `X-Forwarded-Host`, so a proxy in front must pass `Host` through.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { isConfigMutation } from './config-routes.js';

/** A bare DNS hostname: labels of letters, digits and inner hyphens. */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** What is wrong with a `ZVELTIO_CONSOLE_HOST` value; null when it is usable or unset. */
export function consoleHostProblem(value: string | undefined): string | null {
  if (!value) return null;
  if (HOSTNAME.test(value)) return null;
  return (
    `ZVELTIO_CONSOLE_HOST=${JSON.stringify(value)} is not a bare hostname. ` +
    'Give the host only (admin.example.com): no scheme, port, path or wildcard.'
  );
}

/** Throw at boot on an unusable value, rather than fencing nothing or everything. */
export function assertConsoleHost(env: Record<string, string | undefined> = process.env): void {
  const problem = consoleHostProblem(env.ZVELTIO_CONSOLE_HOST);
  if (problem) throw new Error(problem);
}

function consoleHost(): string | null {
  const v = process.env.ZVELTIO_CONSOLE_HOST;
  return v && !consoleHostProblem(v) ? v.toLowerCase() : null;
}

/** The 404 a fenced request gets off the console host; null when it may be served here. */
export function offConsoleHost(c: Context): Response | null {
  const host = consoleHost();
  if (!host || new URL(c.req.url).hostname === host) return null;
  return c.json({ error: 'Not found' }, 404);
}

function fenced(method: string, path: string): boolean {
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/api/admin' ||
    path.startsWith('/api/admin/') ||
    // The CLI's browser confirmation (routes/cli-sign-in.ts): its page is in the
    // Console, and an approval yields a portable session, so a script on another
    // host riding the Console's user must not reach it.
    path.startsWith('/api/auth/cli/') ||
    isConfigMutation(method, path)
  );
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null; // `null` (sandboxed frames, file:) and garbage name no host
  }
}

export function consoleHostFence(): MiddlewareHandler {
  return async (c, next) => {
    const host = consoleHost();
    if (!host) return next();
    if (new URL(c.req.url).hostname !== host) {
      return fenced(c.req.method, c.req.path) ? c.json({ error: 'Not found' }, 404) : next();
    }
    const origin = c.req.header('origin');
    // An identity provider posts its answer back from its own origin (Sign in
    // with Apple's form_post); better-auth checks it against the OAuth state.
    const idpCallback = c.req.path.startsWith('/api/auth/callback/');
    if (origin !== undefined && originHost(origin) !== host && !idpCallback) {
      return c.json({ error: 'Cross-origin request refused on the console host' }, 403);
    }
    return next();
  };
}
