import type { LayoutLoad } from './$types';
import { loadMenus, type MenuItem } from '#lib/ext/content/pages/load.js';
import { engineFetch } from '#lib/engine-fetch.js';

// SPA host (no server runtime in production) — fetch the public site chrome:
// navigation menus (content/pages `page_menus`) + public settings
// (site name, optional theme color). Everything is best-effort: a bare
// install without menus still renders pages, just without a nav bar.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

export const ssr = true;

export const load: LayoutLoad = async ({ fetch }) => {
  const [menus, settings] = await Promise.all([
    // The `main` and `footer` rows of `page_menus` (content/pages), read as the visitor.
    loadMenus(engineFetch(fetch)).catch(() => ({
      main: [] as MenuItem[],
      footer: [] as MenuItem[],
    })),
    fetch(`${ENGINE_URL}/api/settings/public`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}) as Record<string, unknown>),
  ]);

  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    menus,
    site: {
      name: (s.site_name ?? s.company_name ?? s.app_name ?? 'Zveltio') as string,
      themeColor: (s.theme_color as string | undefined) ?? null,
      logoUrl: (s.logo_url as string | undefined) ?? null,
    },
  };
};
