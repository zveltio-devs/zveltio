import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { browser } from '$app/environment';
import type { LayoutLoad } from './$types';

// The admin panel is a client-side SPA — `adapter-static`, no server at
// runtime, so a `+layout.server.ts` here could never run.
export const ssr = false;
export const prerender = false;

/**
 * Check the session BEFORE the shell renders.
 *
 * This lived in `+layout.svelte`'s `onMount`, which runs after the component
 * has mounted — so an unauthenticated visitor saw the whole admin chrome,
 * navigation and all, and was then redirected. No data leaked, because the
 * engine gates every request behind it; what leaked was the shape of the
 * install, and what it looked like was a working admin panel.
 *
 * A universal `load` runs before rendering and still runs in the browser,
 * which is the only place a client-side SPA can check anything. Same change
 * as the client app's `(employee)` and `(partner)` layouts.
 */
export const load: LayoutLoad = async ({ url }) => {
  // Nothing to check while prerendering the shell at build time; auth state
  // lives in cookies/localStorage and exists only in a browser.
  if (!browser) return {};

  const { auth } = await import('$lib/auth.svelte.js');
  await auth.init();
  if (auth.isAuthenticated) return {};

  // Preserve the deep link so the user lands on the page they wanted
  // after sign-in instead of the dashboard.
  const from = url.pathname + url.search;
  const params = new URLSearchParams();
  if (from && from !== '/' && !from.startsWith('/login')) params.set('redirect', from);
  params.set('reason', 'session_required');
  throw redirect(302, `${base}/login?${params.toString()}`);
};
