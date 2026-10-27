/**
 * First path segments the engine and the App own: no extension may mint a public
 * URL under them (a site page slug, a base path). `content/pages` refuses a slug
 * that starts with one; any extension that mints public URLs reads this list.
 * Root files (`robots.txt`, `sitemap.xml`, `favicon.*`) are reserved too.
 */
export const RESERVED_PATH_SEGMENTS: readonly string[] = Object.freeze([
  'api',
  'ext',
  'admin',
  'app',
  'auth',
  '_app',
  '_server',
  '.well-known',
  'robots.txt',
  'sitemap.xml',
]);

/** Whether `path` (`/admin/x`, `admin`, `favicon.ico`) starts with a reserved segment. */
export function isReservedPath(path: string): boolean {
  const first = path.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? '';
  return RESERVED_PATH_SEGMENTS.includes(first) || first.startsWith('favicon.');
}
