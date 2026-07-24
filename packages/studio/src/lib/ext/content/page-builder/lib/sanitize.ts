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

/** Sanitize untrusted HTML before handing it to `{@html ...}`. */
export function safeHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, '');
  ensureStyleHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ADD_ATTR: ['rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}
