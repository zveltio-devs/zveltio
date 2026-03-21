import type { PageServerLoad } from './$types';

/**
 * Fetch page data from Engine's page-builder extension.
 * Catch-all slug: /about, /pricing, /contact → looks up in zv_pages.
 */
export const load: PageServerLoad = async ({ params, fetch }) => {
  const engineUrl = import.meta.env.PUBLIC_ENGINE_URL ?? 'http://localhost:3000';

  const res = await fetch(`${engineUrl}/api/pages/${params.slug}`);

  if (!res.ok) {
    return { status: 404, page: null };
  }

  const { page } = await res.json();
  return { page };
};
