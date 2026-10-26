import { resolve } from '$app/paths';

/**
 * The configured base path (`/admin`) without a trailing slash: what
 * `base` from `$app/paths` was before SvelteKit 3 removed it. `resolve('')`
 * is the base plus `/`.
 */
export const basePath = resolve('').slice(0, -1);
