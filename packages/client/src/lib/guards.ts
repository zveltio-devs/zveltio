import { redirect } from '@sveltejs/kit';

/**
 * Role guard for the client app's authenticated sections.
 *
 * `(employee)` and `(partner)` each had a `+layout.server.ts` that fetched the
 * session and redirected on a missing or insufficient role. It read exactly
 * right, and it never ran: `svelte.config.js` uses `adapter-static` with
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
 */
export async function requireRole(
  fetchFn: typeof fetch,
  url: URL,
  allowed: readonly string[],
): Promise<{ user: { id: string; role: string; [k: string]: unknown } }> {
  const engineUrl =
    import.meta.env.PUBLIC_ENGINE_URL ??
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

  let session: { user?: { id: string; role: string } } | null = null;
  try {
    const res = await fetchFn(`${engineUrl}/api/auth/get-session`, { credentials: 'include' });
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
  if (!allowed.includes(user.role)) {
    throw redirect(302, '/auth/login?error=insufficient_role');
  }
  return { user };
}
