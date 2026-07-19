import type { LayoutLoad } from './$types';

// SPA host (no server runtime in production) — fetch the public site chrome:
// navigation menus from the page-builder CMS contract + public settings
// (site name, optional theme color). Everything is best-effort: a bare
// install without menus still renders pages, just without a nav bar.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

type MenuItem = { label: string; slug?: string; url?: string; external?: boolean };

export const load: LayoutLoad = async ({ fetch }) => {
  const [menus, settings] = await Promise.all([
    fetch(`${ENGINE_URL}/ext/content/page-builder/cms/nav`)
      .then((r) => (r.ok ? r.json() : { menus: { main: [], footer: [] } }))
      .then((d) => d.menus as { main: MenuItem[]; footer: MenuItem[] })
      .catch(() => ({ main: [] as MenuItem[], footer: [] as MenuItem[] })),
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
