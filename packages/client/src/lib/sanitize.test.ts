/**
 * `safeHtml` — the client's XSS boundary.
 *
 * Every `{@html}` in the portal goes through this. It was covered only
 * indirectly, through `BlockRenderer`, which means the coverage was really of
 * the renderer: a change here that loosened the filter would have kept those
 * tests green as long as the block still rendered.
 *
 * These test the boundary itself, and specifically the cases that are easy to
 * regress into. Two deserve naming because they are not what DOMPurify does out
 * of the box:
 *
 *   - `style="background: url(https://evil/track)"` survives a default
 *     sanitize. It is not script execution, so nothing blocks it, and it leaks
 *     a visitor's IP and a page-view to whoever owns the URL. A local hook
 *     drops style values carrying that shape.
 *
 *   - The allow-lists are deliberate rather than inherited. If an upstream
 *     default loosens, an explicit list is what still holds.
 */

import { describe, expect, it } from 'vitest';
import { safeHtml } from './sanitize';

describe('safeHtml — what must not survive', () => {
  it('removes script tags', () => {
    const out = safeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).toContain('hi');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('removes event-handler attributes', () => {
    const out = safeHtml('<p onclick="steal()">text</p>');
    expect(out).toContain('text');
    expect(out.toLowerCase()).not.toContain('onclick');
  });

  it('removes javascript: hrefs while keeping the link text', () => {
    const out = safeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).toContain('click');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('removes iframes, objects and embeds', () => {
    for (const tag of ['iframe', 'object', 'embed']) {
      const out = safeHtml(`<${tag} src="https://evil.test"></${tag}>`);
      expect(out.toLowerCase()).not.toContain(`<${tag}`);
    }
  });

  it('drops a style that fetches a remote URL', () => {
    // The one a default sanitize keeps: no script runs, and the visitor's IP
    // reaches evil.test the moment the page paints.
    const out = safeHtml('<div style="background: url(https://evil.test/track.png)">x</div>');
    expect(out).toContain('x');
    expect(out).not.toContain('evil.test');
  });

  it('drops a style using expression() or @import', () => {
    for (const payload of ['width: expression(alert(1))', '@import url(https://evil.test)']) {
      const out = safeHtml(`<div style="${payload}">x</div>`);
      expect(out).not.toContain('evil.test');
      expect(out.toLowerCase()).not.toContain('expression(');
    }
  });

  it('strips a data: URI from a link', () => {
    // The dangerous direction: navigating to `data:text/html` executes the
    // document. The anchor survives, its destination does not.
    const out = safeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).toContain('x');
    expect(out).not.toContain('data:text/html');
  });

  it('strips vbscript: too', () => {
    const out = safeHtml('<a href="vbscript:msgbox(1)">y</a>');
    expect(out.toLowerCase()).not.toContain('vbscript:');
  });
});

describe('safeHtml — what survives, and why that is not a hole', () => {
  it('keeps a data: URI on an image, deliberately', () => {
    // This looks alarming and is not. DOMPurify permits `data:` on image
    // sources on purpose — inline images are an ordinary, legitimate use — and
    // the payload cannot execute: a browser loading SVG through `<img>` runs it
    // in image mode, where scripts do not run. The dangerous direction, a
    // `data:` destination on a LINK, is stripped (see above).
    //
    // Written down because it has the shape of a finding. An audit reading the
    // output would reasonably flag it, and someone "fixing" it would break
    // every inline image in the portal for no security gain.
    const out = safeHtml('<img src="data:image/svg+xml,<svg />">');
    expect(out).toContain('data:image/svg+xml');
  });

  it('keeps ordinary formatting', () => {
    const out = safeHtml('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(out).toContain('<strong>');
    expect(out).toContain('<em>');
    expect(out).toContain('bold');
  });

  it('keeps links to normal destinations', () => {
    const out = safeHtml('<a href="https://example.com">site</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('site');
  });

  it('keeps site-relative and anchor links', () => {
    expect(safeHtml('<a href="/about">about</a>')).toContain('href="/about"');
    expect(safeHtml('<a href="#section">jump</a>')).toContain('href="#section"');
  });

  it('keeps a benign inline style', () => {
    // The hook drops dangerous VALUES, not the attribute wholesale — an author
    // colouring a paragraph should not lose it.
    const out = safeHtml('<p style="color: red">x</p>');
    expect(out).toContain('color');
  });
});

describe('safeHtml — inputs that are not HTML', () => {
  it('returns empty for a non-string', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(safeHtml(v)).toBe('');
    }
  });

  it('returns empty for an empty string', () => {
    expect(safeHtml('')).toBe('');
  });

  it('leaves plain text alone', () => {
    expect(safeHtml('just words')).toBe('just words');
  });
});
