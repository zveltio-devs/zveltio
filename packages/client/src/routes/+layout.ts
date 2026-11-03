import { browser } from '$app/env';
import { initZveltio } from '#lib/zveltio.js';
import type { Theme } from '@zveltio/ui/theme';
import { loadSite } from '#lib/ext/content/pages/load.js';
import { useDataFetch } from '#lib/ext/content/pages/query.js';
import { engineFetch } from '#lib/engine-fetch.js';

export const ssr = false;
export const prerender = false;

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

export async function load({ fetch }) {
  if (browser) {
    initZveltio().catch(() => {});
    // Data blocks read the data API from the browser, at the engine's origin.
    useDataFetch(engineFetch(window.fetch.bind(window)));
  }

  // Branding and navigation for the `client` site.
  //
  // Its `page_sites` row and published pages (content/pages `loadSite`), read
  // as the visitor; the row's column names are mapped here, once.
  // The theme as data (ADR 0007): the tenant's, else the instance's, from the
  // public settings. A site's own two colours sit on top of it.
  const [siteRes, settingsRes] = await Promise.allSettled([
    loadSite(engineFetch(fetch), 'client'),
    fetch(`${ENGINE_URL}/api/settings/public`, { credentials: 'include' }),
  ]);
  let base: Theme | null = null;
  try {
    if (settingsRes.status === 'fulfilled' && settingsRes.value.ok) {
      base = ((await settingsRes.value.json()) as { theme?: Theme | null }).theme ?? null;
    }
  } catch {
    /* engine not ready — degrade gracefully */
  }

  try {
    const res = siteRes.status === 'fulfilled' ? siteRes.value : null;
    if (res) {
      const { site, nav } = res;
      return {
        tokens: site ? siteTokens(base, site) : base,
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

  return { tokens: base, theme: null, nav: [] };
}

function siteTokens(
  base: Theme | null,
  site: { primary_color?: string; secondary_color?: string },
): Theme {
  const colors = { ...base?.colors };
  if (site.primary_color) colors.primary = site.primary_color;
  if (site.secondary_color) colors.secondary = site.secondary_color;
  return { ...base, colors };
}
