import type { PageLoad } from './$types';

// The public homepage is the page-builder page with slug `home` (ADR 0001).
// Universal load so it runs in the browser (static SPA served by the engine).
// When no homepage is published, `homepage` is null and +page.svelte shows the
// sign-in landing as a fallback.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
  try {
    const res = await fetch(`${ENGINE_URL}/ext/content/page-builder/cms/home`);
    if (!res.ok) return { homepage: null };
    const data = await res.json();
    return { homepage: { page: data.page ?? null, blocks: data.blocks ?? [] } };
  } catch {
    return { homepage: null };
  }
};
