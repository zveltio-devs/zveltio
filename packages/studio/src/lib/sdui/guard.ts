/**
 * Namespace guard for declarative (SDUI) pages.
 *
 * A declarative page may only MUTATE its own extension's `/ext/<name>/` routes.
 * The publish validator is the primary gate; this stops a hand-edited or
 * tampered on-disk schema from calling core endpoints with the admin's cookie.
 *
 * Lives in its own module (rather than inside `SchemaPage.svelte`) so the rule
 * can be tested directly.
 */

/**
 * True when `url` addresses `/ext/<extName>` or something under it.
 *
 * The comparison is made on the *normalized* path: `fetch()` resolves `..` and
 * `.` segments before the request leaves the browser, so a prefix test against
 * the raw string accepts `/ext/foo/../../api/users`, which reaches `/api/users`.
 */
export function isOwnNamespace(extName: string, url: string): boolean {
  const ns = `/ext/${extName}`;
  const base = 'http://sdui.invalid';
  let resolved: URL;
  try {
    // A fixed base makes relative paths resolve the same way as they do in
    // `fetch()`. An absolute URL ignores the base, and its foreign origin is
    // what rejects it below.
    resolved = new URL(url, base);
  } catch {
    return false;
  }
  if (resolved.origin !== base) return false;
  const path = resolved.pathname;
  return path === ns || path.startsWith(`${ns}/`);
}
