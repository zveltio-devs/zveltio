// $app/paths stub for Vitest. Real SvelteKit module is server-only,
// trying to import it in a jsdom test environment fails. Tests that
// need a specific base can vi.mock this module to override.
// Mirrors the client module with the Studio's configured base (vite.config.ts
// `paths.base`): every path, route id or relative, is prefixed with it, so a
// component that drops the base fails here as it would in production.
const BASE = '/admin';
export const resolve = (path: string) => `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
export const asset = resolve;
