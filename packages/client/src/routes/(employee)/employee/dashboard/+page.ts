import type { PageLoad } from './$types';

// SPA load (no server runtime in production) — fetch the resolved dashboard for
// the signed-in user. The engine returns only widgets their role permits.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch(`${ENGINE_URL}/ext/analytics/dashboard`, { credentials: 'include' });
    if (!res.ok) return { dashboard: null, engineUrl: ENGINE_URL, status: res.status };
    return { dashboard: await res.json(), engineUrl: ENGINE_URL, status: 200 };
  } catch {
    return { dashboard: null, engineUrl: ENGINE_URL, status: 502 };
  }
};
