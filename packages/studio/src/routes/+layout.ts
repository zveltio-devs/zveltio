// Zveltio Studio is a fully client-side SPA built with adapter-static.
// Disabling SSR at the root prevents SvelteKit from attempting server-side
// rendering during the static build, which would fail for auth-dependent pages.
export const ssr = false;
export const prerender = false;
