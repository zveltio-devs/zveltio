/**
 * Where a `?redirect=` may actually send someone.
 *
 * The login page reads `?redirect=` and hands it to `goto()` so a user who was
 * bounced from a deep link lands back on it. The value is whatever was in the
 * URL, which means a link like
 *
 *     https://your-zveltio/login?redirect=https://evil.example/login
 *
 * takes the user through a real sign-in and then to a page that can look
 * exactly like the one they just used. The domain in the address bar was
 * genuine for the part they were paying attention to, which is the whole trick.
 *
 * SvelteKit's `goto()` refuses a cross-origin URL today, so this was not
 * exploitable through that path — but the property "we never redirect off-site"
 * belongs to us and should not be borrowed from a framework's current
 * behaviour. Stating it here also covers `window.location` and anything else
 * that grows a redirect later.
 *
 * The rule is deliberately narrow: a same-origin path under `base`. Not "same
 * host" — `//evil.example` and `https:/evil.example` both parse as somewhere
 * else, and a scheme-relative URL is the classic way past a naive check.
 */
export function safeRedirect(target: string | null | undefined, base: string): string {
  const fallback = `${base}/`;
  if (!target) return fallback;

  const t = target.trim();
  // Must be a plain path. `//host` is scheme-relative and `\\host` is treated
  // as one by some browsers, so both are rejected before anything else looks
  // at the string.
  if (!t.startsWith('/') || t.startsWith('//') || t.startsWith('/\\')) return fallback;
  // A backslash anywhere early can smuggle a host past path parsing.
  if (t.includes('\\')) return fallback;
  // Reject anything carrying a scheme — `/\/evil.example` style payloads and
  // `javascript:` alike.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return fallback;

  // Must live under the app's base path, so a deployment mounted at /admin
  // cannot be used to bounce someone to an unrelated app on the same host.
  // Extension floor apps (e.g. Traceability Scan at /ext/.../app/) are same-
  // origin product surfaces — allow those too so login can return the operator
  // to the camera, not dump them on the admin home.
  const underBase = !base || t === base || t.startsWith(`${base}/`);
  const underExt = t.startsWith('/ext/');
  if (!underBase && !underExt) return fallback;

  return t;
}
