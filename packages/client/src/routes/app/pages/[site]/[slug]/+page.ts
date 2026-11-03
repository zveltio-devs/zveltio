import type { PageLoad } from './$types';
import { loadPage } from '#lib/ext/content/pages/load.js';
import { engineFetch } from '#lib/engine-fetch.js';

/**
 * A page of a signed-in site: the same publication read as `(public)/[slug]`,
 * named by its site, with the member's session. Who may read it is the
 * engine's rules on `page_publications` (content/pages); a page the member may
 * not read is not found.
 */
export const ssr = false;

export const load: PageLoad = async ({ params, fetch }) => {
  try {
    const data = await loadPage(engineFetch(fetch), params.slug, { site: params.site });
    if (!data) return { page: null, site: null, blocks: [], record: null, status: 404 };
    return { ...data, status: 200 };
  } catch {
    return { page: null, site: null, blocks: [], record: null, status: 502 };
  }
};
