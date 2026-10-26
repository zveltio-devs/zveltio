// $app/paths stub for Vitest. Real SvelteKit module is server-only,
// trying to import it in a jsdom test environment fails. Tests that
// need a specific base can vi.mock this module to override.
// SvelteKit 3 semantics: a path without a leading `/` is relative to the base.
export const resolve = (path: string) => (path.startsWith('/') ? path : `/${path}`);
export const asset = resolve;
