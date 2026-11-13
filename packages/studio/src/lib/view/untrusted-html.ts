/**
 * A `richtext` value is untrusted on display (ADR 0042 decision 10): an email,
 * a note pasted from anywhere. The attacker is whoever could write it: for
 * mail, anyone who can send a message to a user of the instance, with no
 * account and no permission. What they wrote must not run in Studio's origin
 * with the reader's session, and must not tell them it was opened.
 *
 * Three layers, each enough on its own against script:
 * 1. DOMPurify with a closed allow-list (no `script`, `iframe`, `form`, `meta`,
 *    `base`, `style`, `svg`; no `on*` attribute; only `http(s):`, `mailto:`,
 *    `tel:`, `cid:` and `#` URLs), on a DOMPurify instance of its own;
 * 2. remote content moved out of reach: `src`, `srcset`, `background`,
 *    `poster` and any `url(` style become `data-blocked-*`;
 * 3. the result is drawn in a sandboxed `srcdoc` frame with no `allow-scripts`
 *    and a Content-Security-Policy of `default-src 'none'` (`untrustedDocument`).
 *
 * Remote images stay blocked: whether a reader may load them is undecided
 * (ADR 0038 "Not decided here", kept by ADR 0042 decision 10).
 *
 * Moved from the mail extension's own Studio code (`communications/mail`
 * `studio/src/lib/sanitize.ts`), which ADR 0042 retires: the mail tags are
 * here because real email is table-laid-out and full of `<font>`.
 */
import DOMPurify from 'dompurify';

/** `style` values carrying an execution or exfiltration vector. */
export const DANGEROUS_STYLE = /url\(|expression\(|@import|javascript:|behavior:|-moz-binding/i;

/** A plain colour function: the one kind of `(` a style keeps. */
const COLOUR_FN = /\b(?:rgba?|hsla?)\(\s*[\d.,%\s/]*\)/gi;

/**
 * Whether a style value may stay. CSS loads without spelling `url(`
 * (`image-set('https://…' 1x)`, the escape `\75 rl(`), so any `(` but a plain
 * colour function, and any `\`, drops the whole value; the editor draws it in
 * Studio's own origin, where remote images are allowed.
 */
export function safeStyle(value: string): boolean {
  return !DANGEROUS_STYLE.test(value) && !/[(\\]/.test(value.replace(COLOUR_FN, ''));
}

// biome-ignore format: one line per group
export const ALLOWED_TAGS = [
  // text
  'p', 'br', 'hr', 'span', 'div', 'section', 'article', 'header', 'footer',
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'small', 'mark',
  'blockquote', 'q', 'cite', 'code', 'pre', 'abbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // links and images
  'a', 'img', 'figure', 'figcaption',
  // tables: email layout lives here
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // legacy mail
  'font', 'center', 'big', 'tt',
];

// biome-ignore format: one line per group
export const ALLOWED_ATTRS = [
  'href', 'src', 'srcset', 'alt', 'title', 'width', 'height',
  'target', 'rel', 'class', 'style', 'align', 'valign',
  'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border',
  'bgcolor', 'color', 'face', 'size', 'dir', 'lang',
];

/**
 * The allowed attributes that never hold a URL. DOMPurify tests every allowed
 * attribute outside its URI-safe set against `ALLOWED_URI`, so without this a
 * `width="600"` or `color="red"` (no scheme) was dropped and mail layout broke.
 */
const NOT_URLS = ALLOWED_ATTRS.filter(
  (a) => !['href', 'src', 'srcset', 'target', 'rel', 'class', 'style', 'alt', 'title'].includes(a),
);

/** Schemes a link or an image may use. No `javascript:`, no `data:`. */
export const ALLOWED_URI = /^(?:https?:|mailto:|tel:|cid:|#)/i;

/** Attributes that can pull a remote resource and so report an open. */
const URL_ATTRS = ['src', 'srcset', 'background', 'poster'] as const;

/**
 * May this resource attribute value load? Only a message part (`cid:`) or an
 * inline base64 image; anything else — `https:\\host`, `https:host`,
 * `//host`, a relative path resolved against Studio's origin, a later
 * `srcset` candidate — could reach a server, so it is blocked (inverted check:
 * a list of what may load, never a list of what may not).
 */
const INLINE_RESOURCE = /^(?:cid:[^\s,]+|data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+)$/i;

/** Does this attribute value reach off-origin? */
export function isRemoteUrl(value: string): boolean {
  return !INLINE_RESOURCE.test(value.trim());
}

/**
 * Our own DOMPurify: `addHook` on the shared default instance would change
 * every other `{@html}` sanitiser in the tab (the CMS one keeps `url()` styles
 * on purpose).
 */
let purify: ReturnType<typeof DOMPurify> | null = null;
function purifier(): ReturnType<typeof DOMPurify> {
  if (purify) return purify;
  const instance = DOMPurify(window);
  instance.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'style' && !safeStyle(data.attrValue)) data.keepAttr = false;
  });
  purify = instance;
  return instance;
}

/**
 * Untrusted HTML made inert: sanitised, links opening away with no opener,
 * remote content blocked (kept as `data-blocked-*`, see `restoreBlocked`).
 * With no DOM, the tags are removed and what is left escaped.
 */
export function safeUntrustedHtml(html: unknown): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  if (typeof window === 'undefined') {
    return html.replace(/<[^>]*>/g, '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
  }
  const fragment = purifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ADD_URI_SAFE_ATTR: NOT_URLS,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  const root = document.createElement('div');
  root.appendChild(fragment);
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of URL_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && isRemoteUrl(value)) {
        el.setAttribute(`data-blocked-${attr}`, value);
        el.removeAttribute(attr);
      }
    }
    const style = el.getAttribute('style');
    if (style && /url\(/i.test(style)) {
      el.setAttribute('data-blocked-style', style);
      el.removeAttribute('style');
    }
  }
  return root.innerHTML;
}

/** An editor's content as it is stored: what `safeUntrustedHtml` blocked, put back. */
export function restoreBlocked(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const el of Array.from(copy.querySelectorAll('*'))) {
    for (const attr of [...URL_ATTRS, 'style'] as const) {
      const value = el.getAttribute(`data-blocked-${attr}`);
      if (value === null) continue;
      el.setAttribute(attr, value);
      el.removeAttribute(`data-blocked-${attr}`);
    }
  }
  return copy.innerHTML;
}

/** The text of untrusted HTML, for a table cell. An inert document: nothing loads or runs. */
export function htmlText(html: unknown): string {
  if (typeof html !== 'string') return '';
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]*>/g, ' ');
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The policy of the frame's own document: nothing is fetched, nothing runs. */
export const FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
/** No `allow-scripts`: the frame's document runs nothing. Links open in a new tab. */
export const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

const CSS_COLOR = /^(?:rgba?\([\d.,\s%/]+\)|#[0-9a-f]{3,8})$/i;

/** The `srcdoc` of the frame an untrusted value is drawn in; `color` is the text colour around it. */
export function untrustedDocument(html: unknown, color?: string): string {
  const ink = color && CSS_COLOR.test(color) ? color : 'inherit';
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    '<base target="_blank">' +
    `<style>html{color-scheme:light dark}body{margin:0;font:14px/1.5 system-ui,sans-serif;color:${ink};overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>` +
    `</head><body>${safeUntrustedHtml(html)}</body></html>`
  );
}
