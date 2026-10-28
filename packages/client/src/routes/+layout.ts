import { browser } from '$app/env';
import { initZveltio } from '#lib/zveltio.js';
import type { Theme } from '@zveltio/ui/theme';

export const ssr = false;
export const prerender = false;

const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

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
  // The theme as data (ADR 0007): the tenant's, else the instance's, from the
  // public settings. A site's own two colours sit on top of it.
  const [siteRes, settingsRes] = await Promise.allSettled([
    fetch(`${ENGINE_URL}/ext/content/pages/sites/client/render`, { credentials: 'include' }),
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
    if (res?.ok) {
      const { site, nav } = await res.json();
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
