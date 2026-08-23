import type { PageLoad } from './$types';

/**
 * A PRIVATE page: one that belongs to a site with access roles, or that carries
 * `auth_required` of its own.
 *
 * The counterpart to `(public)/[slug]`, and the difference between them is
 * WHICH ENDPOINT they call, not which files they live in. Public or private is a
 * fact about the page in the database — `auth_required` plus `allowed_roles` —
 * so an author can flip a page from one to the other without anything moving.
 * The route group only decides whether a session is sent and whether the
 * anonymous or the authenticated endpoint answers.
 *
 * `credentials: 'include'` is the whole mechanism on this side. The server does
 * the rest: it refuses without a session (401), refuses without the role (403),
 * and never serves a page whose site is not active.
 */
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

export const load: PageLoad = async ({ params, fetch }) => {
  const base =
    `${ENGINE_URL}/ext/content/pages/sites/${encodeURIComponent(params.site)}` +
    `/render/${encodeURIComponent(params.slug)}`;
  try {
    const res = await fetch(base, { credentials: 'include' });
    if (!res.ok) {
      // 401 and 403 are meaningfully different to a reader — "sign in" versus
      // "this is not yours" — so the status travels rather than collapsing to
      // a single "not found".
      return { page: null, site: null, blocks: [], record: null, status: res.status };
    }
    const data = await res.json();
    return {
      page: data.page ?? null,
      site: data.site ?? null,
      blocks: data.blocks ?? [],
      record: data.record ?? null,
      blocksBaseUrl: `${base}/blocks`,
      status: 200,
    };
  } catch {
    return { page: null, site: null, blocks: [], record: null, status: 502 };
  }
};
