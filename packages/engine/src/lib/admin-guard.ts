import type { Context, ContextVariableMap } from 'hono';

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
 * route.
 *
 * `allowed` is the route's own check (`requireInstanceAdmin`, `isTenantAdmin`,
 * `isGodUser`): this helper decides the status code, never who gets through.
 */
export async function guardAdmin(
  c: Context,
  auth: SessionSource,
  allowed: (userId: string) => Promise<boolean>,
): Promise<SessionUser | Response> {
  const session = (await auth.api.getSession({ headers: c.req.raw.headers })) as {
    user: SessionUser;
  } | null;
  if (!session) return c.json({ error: 'Unauthorized' }, 401);
  if (!(await allowed(session.user.id))) return c.json({ error: 'Admin access required' }, 403);
  return session.user;
}
