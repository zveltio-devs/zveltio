import type { LayoutLoad } from './$types';
import { requireRole } from '$lib/guards';

/**
 * Runs in the browser, unlike the `+layout.server.ts` it replaces — the app is
 * built by `adapter-static` into an SPA, so there is no server to execute a
 * server load. See `$lib/guards.ts`.
 */
export const load: LayoutLoad = ({ fetch, url }) =>
  requireRole(fetch, url, ['employee', 'manager', 'admin', 'god']);
