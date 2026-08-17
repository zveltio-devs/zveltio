import type { PageLoad } from './$types';

// The root `/` is the app entry: a login/sign-up landing by DEFAULT (ADR 0001 —
// Zveltio is app/intranet-first, not public-first). It only shows a public page
// if the operator opted into one by publishing a page-builder homepage (slug
// `home`); absent that, login is not a "fallback" — it's the intended default.
//
// Universal load so it runs in the browser (static SPA served by the engine).
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

export const ssr = false;

export const load: PageLoad = async ({ fetch }) => {
  // Optional public homepage (only present if content/pages is installed AND a
  // `home` page is published on a PUBLIC site). Any failure just means "no public homepage".
  let homepage: {
    page: unknown;
    blocks: unknown[];
    popups: unknown[];
    blocksBaseUrl: string;
  } | null = null;
  try {
    const res = await fetch(`${ENGINE_URL}/ext/content/pages/cms/home`);
    if (res.ok) {
      const data = await res.json();
      if (data?.page) {
        homepage = {
          page: data.page,
          blocks: data.blocks ?? [],
          popups: data.popups ?? [],
          // Where a data block asks for its next window. Built here because this
          // is where the engine's base URL is resolved.
          blocksBaseUrl: `${ENGINE_URL}/ext/content/pages/cms/home/blocks`,
        };
      }
    }
  } catch {
    /* no public homepage — login landing is the default */
  }

  // Whether the login landing should offer "Create Account". Default false: the
  // server enforces the same gate, so self-signup is opt-in per instance.
  let registrationEnabled = false;
  try {
    const res = await fetch(`${ENGINE_URL}/api/settings/public`);
    if (res.ok) {
      const s = await res.json();
      registrationEnabled = s?.registration_enabled === true;
    }
  } catch {
    /* keep default (no signup) */
  }

  return { homepage, registrationEnabled };
};
