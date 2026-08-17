import type { PageLoad } from './$types';

// Universal load — runs in the browser (the host ships as a static SPA served by
// the engine, so there is no server runtime; `+page.server.ts` would never run
// in production). Fetches the published page from the page-builder public
// contract (ADR 0001). Multi-tenant installs resolve the tenant by Host header
// server-side, so no tenant plumbing is needed here.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

export const load: PageLoad = async ({ params, fetch }) => {
  try {
    // `content/pages`, not `content/page-builder`: that extension was merged
    // away, and this loader kept calling it — every public page 404'd.
    const res = await fetch(
      `${ENGINE_URL}/ext/content/pages/cms/${encodeURIComponent(params.slug)}`,
    );
    if (!res.ok) return { page: null, blocks: [], popups: [], record: null, status: res.status };
    const data = await res.json();
    return {
      page: data.page ?? null,
      blocks: data.blocks ?? [],
      popups: data.popups ?? [],
      record: data.record ?? null,
      blocksBaseUrl: `${ENGINE_URL}/ext/content/pages/cms/${encodeURIComponent(params.slug)}/blocks`,
      status: 200,
    };
  } catch {
    return { page: null, blocks: [], popups: [], record: null, status: 502 };
  }
};
