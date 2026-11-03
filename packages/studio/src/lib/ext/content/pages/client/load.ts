/**
 * What a host needs to draw one page, read from the data API as the visitor.
 *
 * A page on a site is its row of `page_publications` — the sanitized snapshot
 * `publish` made — never the draft. Everything here is a plain data API read
 * with the visitor's session, or none: the engine serves an anonymous visitor
 * as the tenant's `public` role (ADR 0017), so what a visitor sees is what the
 * operator opened to them, and nothing else decides.
 *
 * `fetch` is the host's (SvelteKit's `load` fetch on the server, the browser's
 * otherwise). Returns `null` for anything the visitor may not read or that does
 * not exist — the two are the same answer to a visitor.
 */
import { NAME, filterJson } from './query.js';

/** Any `fetch` for a path: the browser's, SvelteKit's `load` fetch, or a host wrapper. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
// biome-ignore lint/suspicious/noExplicitAny: data API rows are untyped JSON
type Row = Record<string, any>;

export type PagePayload = {
  page: Row;
  record: Row | null;
  site: { name: string; logo_url: string | null; primary_color: string | null; custom_css: string | null };
  blocks: unknown[];
  popups: { id: string; title: string; config: Row; blocks: unknown[] }[];
};

export type MenuItem = { label: string; slug?: string; url?: string; external?: boolean };

export type NavItem = {
  id: string;
  title: string;
  slug: string;
  icon: string | null;
  sort_order: number;
  is_homepage: boolean;
  children: NavItem[];
};

async function rows(f: Fetch, collection: string, filter: Row, extra = ''): Promise<Row[]> {
  const res = await f(`/api/data/${collection}?filter=${encodeURIComponent(JSON.stringify(filter))}${extra}`, {
    credentials: 'include',
  });
  if (!res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return Array.isArray(json.records) ? json.records : [];
}

/** The id of the site named by `siteSlug`, `undefined` when none is named, `null` when it is not readable. */
async function siteId(f: Fetch, siteSlug?: string): Promise<string | null | undefined> {
  if (!siteSlug) return undefined;
  return (await rows(f, 'page_sites', { slug: siteSlug, is_active: true }, '&limit=1'))[0]?.id ?? null;
}

/**
 * The published page at `slug` (`''` = the homepage), with its record when it
 * is a record page and `recordKey` names one, its site's branding and its popups.
 */
export async function loadPage(
  f: Fetch,
  slug: string,
  opts: { recordKey?: string; site?: string } = {},
): Promise<PagePayload | null> {
  const site = await siteId(f, opts.site);
  if (site === null) return null;
  const scope: Row = site ? { site_id: site, kind: 'page' } : { kind: 'page' };

  // ponytail: without a site named, the first readable publication with the slug wins; name the site when one tenant runs several public sites.
  const pub = slug
    ? (await rows(f, 'page_publications', { ...scope, slug }, '&limit=1'))[0]
    : ((await rows(f, 'page_publications', { ...scope, is_homepage: true }, '&limit=1'))[0] ??
      (await rows(f, 'page_publications', { ...scope, slug: 'home' }, '&limit=1'))[0]);
  if (!pub) return null;
  const content: Row = pub.content ?? {};

  let record: Row | null = null;
  if (content.record_collection) {
    const field = content.record_field || 'slug';
    if (!opts.recordKey || !NAME.test(content.record_collection) || !NAME.test(field)) return null;
    // The key joins the author's own conditions on the field; it never replaces them.
    const filter = JSON.parse(filterJson(content.record_filter) ?? '{}');
    filter[field] = { ...filter[field], eq: opts.recordKey };
    record = (await rows(f, content.record_collection, filter, '&limit=1'))[0] ?? null;
    if (!record) return null;
  } else if (opts.recordKey) {
    return null;
  }

  // A site switched off is not drawn; the visitor needs `read` on `page_sites` too.
  const [siteRow] = await rows(f, 'page_sites', { id: pub.site_id, is_active: true }, '&limit=1');
  if (!siteRow) return null;
  const popups = (await rows(f, 'page_publications', { site_id: pub.site_id, kind: 'popup' }, '&limit=50'))
    .map((p) => ({ id: p.id, title: p.title, config: p.content?.popup_config ?? {}, blocks: p.content?.blocks ?? [] }))
    .filter((p) => {
      const targets: unknown = p.config.targets;
      return !Array.isArray(targets) || targets.length === 0 || targets.includes(pub.slug);
    });

  return {
    page: {
      id: pub.page_id,
      title: pub.title,
      slug: pub.slug,
      is_homepage: pub.is_homepage === true,
      description: content.description ?? null,
      meta_title: content.meta_title ?? content.meta?.title ?? pub.title,
      meta_description: content.meta_description ?? content.meta?.description ?? null,
      og_image: content.og_image ?? content.meta?.og_image ?? null,
      noindex: pub.is_noindex === true,
      locale: content.locale ?? null,
    },
    record,
    site: {
      name: siteRow.site_name ?? siteRow.name,
      logo_url: siteRow.site_logo_url ?? null,
      primary_color: siteRow.primary_color ?? null,
      custom_css: siteRow.custom_css ?? null,
    },
    blocks: Array.isArray(content.blocks) ? content.blocks : [],
    popups,
  };
}

/** The `main` and `footer` menus, empty when they are missing or not readable. */
export async function loadMenus(f: Fetch): Promise<{ main: MenuItem[]; footer: MenuItem[] }> {
  const list = await rows(f, 'page_menus', {}, '&limit=50');
  const items = (key: string) => {
    const v = list.find((m) => m.menu_key === key)?.items;
    return Array.isArray(v) ? (v as MenuItem[]) : [];
  };
  return { main: items('main'), footer: items('footer') };
}

/**
 * A site's row and its navigation: the published pages of the site, in
 * `sort_order`, children under their parent. `null` when the site is missing
 * or not readable.
 */
export async function loadSite(f: Fetch, siteSlug: string): Promise<{ site: Row; nav: NavItem[] } | null> {
  const [site] = await rows(f, 'page_sites', { slug: siteSlug, is_active: true }, '&limit=1');
  if (!site) return null;
  const pubs = await rows(f, 'page_publications', { site_id: site.id, kind: 'page' }, '&limit=500&sort=sort_order&order=asc');
  const item = (p: Row): NavItem => ({
    id: p.page_id,
    title: p.title,
    slug: p.slug,
    icon: p.icon ?? null,
    sort_order: p.sort_order ?? 0,
    is_homepage: p.is_homepage === true,
    children: [],
  });
  const slugs = new Set(pubs.map((p) => p.slug));
  const nav = pubs.filter((p) => !p.parent_slug || !slugs.has(p.parent_slug)).map(item);
  for (const top of nav) {
    top.children = pubs.filter((p) => p.parent_slug === top.slug).map(item);
  }
  return { site, nav };
}
