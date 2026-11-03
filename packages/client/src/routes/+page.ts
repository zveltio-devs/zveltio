import type { PageLoad } from './$types';
import { loadPage, type PagePayload } from '#lib/ext/content/pages/load.js';
import { engineFetch } from '#lib/engine-fetch.js';

// The root `/` is the app entry: a login/sign-up landing by DEFAULT (ADR 0001 —
// Zveltio is app/intranet-first, not public-first). It only shows a public page
// if the operator opted into one by publishing a page-builder homepage (slug
// `home`); absent that, login is not a "fallback" — it's the intended default.
//
// Universal load: rendered on the server by the engine (ADR 0005) and again in the browser.
const ENGINE_URL: string =
  import.meta.env.PUBLIC_ENGINE_URL ||
  (typeof window !== 'undefined' ? window.location.origin : '');

export const ssr = true;

export const load: PageLoad = async ({ fetch }) => {
  // Optional public homepage: the publication a site flags as its homepage,
  // if content/pages is installed and the visitor may read it. Any failure just
  // means "no public homepage".
  let homepage: PagePayload | null = null;
  try {
    homepage = await loadPage(engineFetch(fetch), '');
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
