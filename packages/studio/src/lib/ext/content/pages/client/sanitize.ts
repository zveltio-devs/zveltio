/**
 * Sanitize page content before `{@html ...}`.
 *
 * `TextSection` rendered `{@html content}` raw. The content comes from the CMS,
 * which means from whoever can edit a page — an editor, not necessarily an
 * administrator — and it renders on the PUBLIC site, in every visitor's
 * browser. A `<script>` or an `onerror=` in a text block therefore ran with the
 * site's origin: session cookies, any logged-in visitor's admin session, the
 * lot.
 *
 * The core client shipped exactly this component and had it fixed months ago;
 * the copy in the extension's client bundle — the one third-party SvelteKit
 * apps import — was left behind. Same component, two places, one of them
 * patched. Rendering the same content through a different file is not a reason
 * to render it differently.
 *
 * The allow-list mirrors the one in `../studio/src/lib/sanitize.ts` so the
 * author's editor preview and the published page agree about what survives.
 */

import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'span', 'div', 'hr', 'sub', 'sup', 'small', 'mark',
];

const ALLOWED_ATTRS = [
  'href', 'src', 'alt', 'title', 'width', 'height',
  'target', 'rel', 'class', 'style', 'colspan', 'rowspan',
];

/**
 * Returns HTML safe to hand to `{@html ...}`.
 *
 * Server-side there is no DOM for DOMPurify to work against, so tags are
 * stripped entirely rather than trusted. That degrades the first paint of a
 * server-rendered page to plain text instead of shipping unsanitised markup,
 * which is the right way round.
 *
 * That was true only for WELL-FORMED markup. `replace(/<[^>]*>/g, '')` needs a
 * closing `>` to match, so an UNCLOSED tag passed through untouched — and an
 * HTML parser closes one for you at the end of a document. Measured on the
 * shipped expression:
 *
 *   '<img src=x onerror=alert(1)>'  -> ''                              stripped
 *   '<img src=x onerror=alert(1)'   -> '<img src=x onerror=alert(1)'   INTACT
 *   'Hello <svg onload=alert(1)'    -> 'Hello <svg onload=alert(1)'    INTACT
 *
 * On the public site this is defence in depth — the engine's `sanitize-html`
 * has already parsed the same content structurally, on write and again on the
 * public read path, and would have dropped these. But `safeHtml` is exported
 * from this client bundle for third-party SvelteKit apps to import, and its
 * contract is "returns HTML safe to hand to {@html}". A caller handing it
 * unsanitised content — the case the function exists for — got a bypass.
 *
 * Complete tags are still removed, so well-formed input renders as before. What
 * is left over is escaped rather than deleted: `a < b` stays readable, and a
 * dangling `<img …` becomes text instead of an element.
 */
export function safeHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') {
    return html.replace(/<[^>]*>/g, '').replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ADD_ATTR: ['rel'],
    // No `javascript:`, no `data:` — a data: URL in an <a> is a same-origin
    // navigation in older browsers and a download prompt in the rest.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });
}
