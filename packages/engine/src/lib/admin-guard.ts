import type { Context, ContextVariableMap } from 'hono';
import { getDb } from '../db/index.js';
import { requestSession } from '../middleware/session-prefetch.js';
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
 * Session + role gate for admin-only routes: 401 when nobody is signed in, 403
 * when somebody is but `allowed` refuses them, otherwise the session user.
 *
 * The two answers must stay apart. The SDK reads every 401 as "the session is
 * gone" and fires `onUnauthorized`, so a guard that answered 401 to a signed-in
 * member made any SDK client treat them as signed out for touching an admin
 * route. A valid API key is somebody too, so it gets 403; no key here ever
 * passes, only the status it is refused with depends on the key.
 *
 * `allowed` is the route's own check (`requireInstanceAdmin`, `isTenantAdmin`,
 * `isGodUser`): this helper decides the status code, never who gets through.
 */
export async function guardAdmin(
  c: Context,
  auth: SessionSource,
  allowed: (userId: string) => Promise<boolean>,
): Promise<SessionUser | Response> {
  const session = await requestSession(c, auth);
  if (!session) {
    return (await presentsUsableKey(c))
      ? c.json({ error: 'Admin access required' }, 403)
      : c.json({ error: 'Unauthorized' }, 401);
  }
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
