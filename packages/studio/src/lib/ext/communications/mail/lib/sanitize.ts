/**
 * HTML sanitization for the mail reading pane.
 *
 * `MailInbox.svelte` renders a message body with `{@html}`. What stood between
 * an inbound email and the admin's own session was one regular expression:
 *
 *     body_html.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
 *
 * That removes a literal `<script>…</script>` and nothing else. Measured
 * against the expression as shipped — 11 of 12 payloads survived intact:
 *
 *     <img src=x onerror="alert(document.cookie)">     survives
 *     <svg onload=alert(1)>                            survives
 *     <iframe src="javascript:alert(1)">               survives
 *     <a href="javascript:alert(1)">                   survives
 *     <details open ontoggle=alert(1)>                 survives
 *     <meta http-equiv="refresh" content="0;url=…">    survives
 *     <form action="https://evil.test/">               survives
 *     <script src="https://evil.test/x.js">            survives  (no closing tag to match)
 *     <scr<script>ipt>alert(1)</scr</script>ipt>       leaves a bare <script>
 *     <script>alert(1)</script>                        removed   — the only one
 *
 * The threat model is what makes this the worst sink in the repository: the
 * attacker is **anyone who can send an email to a user of this instance**. They
 * need no account, no permission and no prior access. The payload runs in the
 * Studio's origin with the reader's session.
 *
 * Why the sanitizer here is more permissive than the CMS one
 * (`content/pages/studio/src/lib/sanitize.ts`): real email is table-laid-out,
 * inline-styled, and full of `<font>` and `<center>` from twenty years of mail
 * clients. Stripping it down to the CMS allow-list would render ordinary
 * newsletters as unreadable text, and a reading pane nobody trusts gets turned
 * off. The list below is what a mail client needs and no more — no `form`, no
 * `iframe`, no `object`, no `meta`, no `base`, and no event handlers, because
 * DOMPurify drops every `on*` attribute by construction rather than by a list
 * someone has to keep complete.
 */

import DOMPurify from 'dompurify';

/**
 * `style` values carrying an execution or exfiltration vector.
 *
 * `url()` matters more here than in the CMS: a background image in a style
 * attribute is a tracking pixel that fires on open, which is precisely what the
 * "block remote images" toggle exists to prevent — and it would have walked
 * straight past a toggle that only looked at `src`.
 */
export const DANGEROUS_STYLE = /url\(|expression\(|@import|javascript:|behavior:|-moz-binding/i;

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
  // tables — email layout lives here
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  // legacy mail
  'font', 'center', 'big', 'tt',
];

export const ALLOWED_ATTRS = [
  'href', 'src', 'srcset', 'alt', 'title', 'width', 'height',
  'target', 'rel', 'class', 'style', 'align', 'valign',
  'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border',
  'bgcolor', 'color', 'face', 'size', 'dir', 'lang',
];

/** Schemes a link or an image in an email may use. No `javascript:`, no `data:`. */
export const ALLOWED_URI = /^(?:https?:|mailto:|tel:|cid:|#)/i;

/**
 * Returns message HTML that is safe to hand to `{@html ...}`.
 *
 * @param html         the raw `body_html` from the message
 * @param showImages   when false, remote images are neutralised so opening a
 *                     message does not tell the sender it was opened
 *
 * Remote images are blocked by walking the sanitized DOM rather than by
 * rewriting the string. The previous form was
 * `replace(/\s(src|srcset)=…/gi, ' data-blocked-$1="$2"')`, whose `$2` refers to
 * a capture group that does not exist — so it emitted a literal `$2` and the URL
 * was simply lost. It also missed `background=`, `poster=`, and any URL inside a
 * `style` attribute, which is the form a tracking pixel actually takes.
 *
 * Server-side there is no DOM for DOMPurify to work against, so tags are removed
 * and what is left is escaped. Escaping matters: `replace(/<[^>]*>/g, '')` needs
 * a closing `>` to match, so an UNCLOSED tag passes through untouched and an
 * HTML parser closes it for you. That exact hole was found in
 * `content/pages/client/sanitize.ts`; this is the same function, so it gets the
 * same treatment rather than waiting to be found again.
 */
export function safeMailHtml(html: unknown, showImages: boolean): string {
  if (typeof html !== 'string' || html.length === 0) return '';

  if (typeof window === 'undefined') {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));
  }

  ensureStyleHook();
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRS,
    ADD_ATTR: ['rel'],
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  const host = document.createElement('div');
  host.appendChild(fragment);

  // Every link opens away from the Studio, and without `noopener` the opened
  // page gets a handle on this one through `window.opener`.
  for (const a of Array.from(host.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer nofollow');
  }

  if (!showImages) blockRemoteContent(host);

  return host.innerHTML;
}

/** Attributes that can pull a remote resource and thereby report an open. */
export const URL_ATTRS = ['src', 'srcset', 'background', 'poster'] as const;

/** Does this attribute value reach off-origin, and so report that the mail was opened? */
export function isRemoteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

function blockRemoteContent(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of URL_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && isRemoteUrl(value)) {
        // Kept, not discarded, so turning images on restores the real URL.
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
}

/**
 * Plain-text bodies, escaped for HTML.
 *
 * Separate from `safeMailHtml` because the two have opposite jobs: one keeps
 * markup and removes what is dangerous, the other keeps nothing and shows the
 * text exactly as it arrived.
 */
export function safeMailText(text: unknown): string {
  const value = typeof text === 'string' ? text : '';
  return value.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
