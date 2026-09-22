import { browser } from '$app/environment';
import { initZveltio } from '$lib/zveltio';

export const ssr = false;
export const prerender = false;

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export async function load({ fetch }) {
  if (browser) {
    initZveltio().catch(() => {});
  }

  // Branding and navigation for the `client` site.
  //
  // This called `/api/zones/client/render` and read `zone`/`pages`. The engine
  // stopped mounting `/api/zones` when zones became sites in `content/pages`,
  // so the request 404'd on every install and the failure fell into the catch
  // below: the host has been rendering its own defaults — no logo, no site
  // name, no navigation — and looking like it had simply not been configured.
  //
  // The site row carries its own column names, which are not the zone's. They
  // are mapped here rather than at every reader, so the layout and the landing
  // page keep the one shape they already use.
  try {
    const res = await fetch(`${ENGINE_URL}/ext/content/pages/sites/client/render`, {
      credentials: 'include',
    });
    if (res.ok) {
      const { site, nav } = await res.json();
      return {
        theme: site
          ? {
              app_name: site.site_name ?? site.name ?? null,
              logo_url: site.site_logo_url ?? null,
              color_primary: site.primary_color ?? null,
              color_secondary: site.secondary_color ?? null,
              custom_css: site.custom_css ?? null,
              // The site vocabulary is sidebar | topbar | both; the layout's is
              // sidebar | top | none.
              nav_position: site.nav_position === 'topbar' ? 'top' : (site.nav_position ?? 'top'),
            }
          : null,
        nav: nav ?? [],
      };
    }
  } catch {
    /* engine not ready — degrade gracefully */
  }

  return { theme: null, nav: [] };
}
