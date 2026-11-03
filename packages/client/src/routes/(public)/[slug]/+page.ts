import type { PageLoad } from './$types';
import { loadPage } from '#lib/ext/content/pages/load.js';
import { engineFetch } from '#lib/engine-fetch.js';

// Universal load. The published page is read from the data API as the visitor
// (`loadPage`, content/pages): an anonymous visitor is the tenant's `public`
// role, which reads only what the operator granted it (ADR 0017). Multi-tenant
// installs resolve the tenant by Host header server-side.
export const load: PageLoad = async ({ params, fetch }) => {
  try {
    const data = await loadPage(engineFetch(fetch), params.slug);
    if (!data) return { page: null, blocks: [], popups: [], record: null, status: 404 };
    return { ...data, status: 200 };
  } catch {
    return { page: null, blocks: [], popups: [], record: null, status: 502 };
  }
};
