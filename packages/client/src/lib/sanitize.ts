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
