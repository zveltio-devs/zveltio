// Admin panel is a client-side SPA — SSR disabled for all auth-protected routes.
// Auth is checked in +layout.svelte via onMount → auth.init(), which requires
// the browser environment (localStorage / cookies). SSR would expose unauthenticated
// shell HTML and cannot access auth state.
export const ssr = false;
export const prerender = false;
