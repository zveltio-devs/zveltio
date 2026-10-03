import type { Context } from 'hono';
import { matchedRoutes } from 'hono/route';

/**
 * What a log, a trace or an audit row may record of a request's address.
 *
 * Some routes carry a credential in the path: `GET /api/invitations/:token` is
 * a live invitation, so `zv_request_logs.path` held working invite links that
 * migration 038 had just removed from the database (050 scrubs the old rows).
 * Query strings carry them too — better-auth's `?token=` verify and magic links,
 * OAuth `?code=&state=`, the realtime socket's `?token=` — and the trace span's
 * `http.url` and `zv_slow_queries.query_params` recorded those verbatim.
 */

/** A path parameter whose value is a credential. */
const SECRET_PARAM = /^:(token|secret|signature|otp)(\{.*\})?$/i;

/** A query key whose value is a credential. */
const SECRET_QUERY = /token|secret|password|signature|^sig$|^code$|^state$|^otp$|api_?key/i;

/**
 * Routes no Hono pattern names: better-auth answers everything under
 * `/api/auth/*` from one handler, so its own `:token` is invisible to
 * `matchedRoutes`.
 */
const UNREGISTERED = ['/api/auth/reset-password/:token'];

function redactWith(pattern: string, path: string): string | null {
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length || !want.some((s) => SECRET_PARAM.test(s))) return null;
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    if (!w.startsWith(':') && w !== '*' && w !== have[i]) return null;
  }
  return want.map((w, i) => (SECRET_PARAM.test(w) ? w.replace(/\{.*$/, '') : have[i])).join('/');
}

/** The request path with every credential segment replaced by its parameter name. */
export function loggablePath(c: Context): string {
  const path = c.req.path;
  let patterns: string[] = [];
  try {
    patterns = matchedRoutes(c).map((r) => r.path);
  } catch {
    // Not routed (a bare Context in a test): the fixed list still applies.
  }
  for (const p of [...patterns, ...UNREGISTERED]) {
    const red = redactWith(p, path);
    if (red) return red;
  }
  return path;
}

/** The query parameters, with credential values replaced. */
export function loggableQuery(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    out[k] = SECRET_QUERY.test(k) ? '[redacted]' : v;
  }
  return out;
}

/** The full URL as `loggablePath` + `loggableQuery` spell it. */
export function loggableUrl(c: Context): string {
  const url = new URL(c.req.url);
  url.pathname = loggablePath(c);
  for (const k of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(k)) url.searchParams.set(k, '[redacted]');
  }
  return url.toString();
}
