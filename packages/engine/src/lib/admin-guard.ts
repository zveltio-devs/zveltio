import type { Context, ContextVariableMap } from 'hono';
import { getDb } from '../db/index.js';
import { type RequestSession, requestSession } from '../middleware/session-prefetch.js';
import { findApiKey, requestApiKey } from './data/index.js';
import { tenantId } from './route-db.js';
import { apiKeyActsIn } from './tenancy/index.js';

/** The user a guarded route publishes as `c.set('user', …)`. */
type SessionUser = ContextVariableMap['user'];

/**
 * Loose on purpose: routes hold better-auth as `any`, and the typed instance
 * overloads `getSession` on `returnHeaders`, which no single signature matches.
 * Called without `returnHeaders`, it answers `{ session, user } | null`.
 */
interface SessionSource {
  api: { getSession(opts: { headers: Headers }): Promise<unknown> };
}

/**
 * Session gate for routes that take a signed-in user and nothing else: the
 * session, or the refusal `refuseWithoutSession` picks.
 */
export async function guardSession(
  c: Context,
  auth: SessionSource,
): Promise<RequestSession | Response> {
  return (await requestSession(c, auth)) ?? refuseWithoutSession(c);
}

/**
 * The answer to a request with no session: 401 when it names nobody, 403 when
 * it carries a valid API key of this tenant.
 *
 * The two answers must stay apart. The SDK reads every 401 as "the session is
 * gone" and fires `onUnauthorized`, so a route that answered 401 to a valid key
 * signed an SDK client authenticated by that key out for touching it. A key is
 * somebody; it is refused, never let in — only the status depends on the key.
 * `unauthorized` keeps a route's existing 401 text.
 */
export async function refuseWithoutSession(
  c: Context,
  unauthorized = 'Unauthorized',
): Promise<Response> {
  return (await presentsUsableKey(c))
    ? c.json({ error: 'Session required' }, 403)
    : c.json({ error: unauthorized }, 401);
}

/**
 * Session + role gate for admin-only routes: `guardSession`'s refusal when
 * nobody is signed in, 403 when somebody is but `allowed` refuses them,
 * otherwise the session user. A 401 to a signed-in member would sign them out
 * in the SDK exactly as it would a key.
 *
 * `allowed` is the route's own check (`requireInstanceAdmin`, `isTenantAdmin`,
 * `isGodUser`): this helper decides the status code, never who gets through.
 */
export async function guardAdmin(
  c: Context,
  auth: SessionSource,
  allowed: (userId: string) => Promise<boolean>,
): Promise<SessionUser | Response> {
  const session = await guardSession(c, auth);
  if (session instanceof Response) return session;
  if (!(await allowed(session.user.id))) return c.json({ error: 'Admin access required' }, 403);
  return session.user;
}

/**
 * Does the request carry a key that authenticates in this request's tenant —
 * the same `findApiKey` + `apiKeyActsIn` test `validateApiKey` applies? Reuses
 * the prefetched row; looks it up only where the prefetch did not run.
 */
async function presentsUsableKey(c: Context): Promise<boolean> {
  const raw = requestApiKey(c);
  if (!raw) return false;
  let key = c.get('prefetchedApiKey');
  if (key === undefined) {
    // A failed lookup answers 401, as a missing key would: it decides only the status.
    try {
      key = await findApiKey(getDb(), raw);
    } catch {
      key = null;
    }
  }
  return !!key && apiKeyActsIn(key.tenant_id, tenantId(c));
}
