import { redirect } from '@sveltejs/kit';

/**
 * Sign-in guard for the App's workspace, `/app` (ADR 0006).
 *
 * `(employee)` and `(partner)` each had a `+layout.server.ts` that fetched the
 * session and redirected on a missing or insufficient role. It read exactly
 * right, and it never ran: `vite.config.ts` uses `adapter-static` with
 * `fallback: 'index.html'`, so the build produces a static SPA and there is no
 * server at runtime to execute a server load. The root layout also sets
 * `ssr = false`. Every visitor got the shell regardless of who they were.
 *
 * That mattered less than it looks — the data comes from the engine, which
 * checks authorisation on every call, so an unauthenticated visitor saw an
 * empty frame rather than anybody's records. What was actually broken is worse
 * in a quieter way: the codebase asserted a protection it did not have, and
 * anyone reading those files would reasonably have stopped worrying about it.
 *
 * So the guard lives in a universal load instead, which does run in the
 * browser, and the dead server loads are gone rather than left as decoration.
 *
 * This is a routing guard, not an authorisation boundary. The engine remains
 * the only thing standing between a request and data; a determined visitor can
 * always skip client-side code. What this buys is that people who are not
 * signed in land on the login page instead of a broken-looking empty app.
 *
 * It asks `/api/me`, not better-auth's `/api/auth/get-session`: `/api/me`
 * returns the `user` row plus `roles`, the caller's Casbin roles, which the
 * session does not carry.
 *
 * It checks no role. It used to admit `(employee)` for employee/manager/admin
 * and `(partner)` for partner/manager/admin, which bounced every signed-in user
 * holding any other role — a `sales` or `accountant` role an operator made —
 * from the whole app. The App is split from the Console by what the user does,
 * not by who they are: everyone signed in gets the workspace, and what it shows
 * is what the engine lets them read.
 */
export async function requireUser(
  fetchFn: typeof fetch,
  url: URL,
): Promise<{
  user: {
    id: string;
    role: string;
    roles: string[];
    name?: string;
    email?: string;
    [k: string]: unknown;
  };
}> {
  const engineUrl =
    import.meta.env.PUBLIC_ENGINE_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

  let session: {
    user?: { id: string; role: string; roles?: string[]; name?: string; email?: string };
  } | null = null;
  try {
    const res = await fetchFn(`${engineUrl}/api/me`, { credentials: 'include' });
    if (res.ok) session = await res.json();
  } catch {
    // Engine unreachable. Treat it as "not signed in" — sending someone to the
    // login page when the backend is down is a clearer failure than rendering
    // an application shell that cannot load anything.
    session = null;
  }

  const user = session?.user;
  if (!user) {
    throw redirect(302, `/auth/login?returnTo=${encodeURIComponent(url.pathname)}`);
  }
  return { user: { ...user, roles: user.roles ?? [] } };
}

/**
 * Where signing in lands: the `returnTo` the guard put on the login URL, or the
 * workspace. Resolved against this origin and refused when it leaves it, so
 * `?returnTo=//evil.test` or `?returnTo=https://evil.test` cannot turn the
 * login page into a redirector. A path that normalises to `//host`
 * (`/.//evil.test`) is same-origin to the parser and protocol-relative to the
 * navigation that follows, so it is refused too.
 */
export function afterSignIn(url: URL): string {
  const to = url.searchParams.get('returnTo');
  if (to) {
    const target = new URL(to, url.origin);
    if (target.origin === url.origin && !target.pathname.startsWith('//')) {
      return target.pathname + target.search + target.hash;
    }
  }
  return '/app';
}
