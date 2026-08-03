/**
 * Theme values reach the page unescaped-for-their-context.
 *
 * `custom_css` was written into `<style>{...}</style>`. Svelte escapes for
 * HTML; inside a `<style>` element the browser parses CSS, where `</style>`
 * ends the block and everything after it is markup again. Whoever can edit a
 * zone theme could therefore put a script on every page of the public site.
 *
 * `favicon_url` and `logo_url` go into `href`/`src`, where `javascript:` is not
 * an injection at all — just a URL the browser runs when clicked.
 */

import { describe, expect, it } from 'vitest';
import { safeCss, safeImageUrl } from './sanitize';

describe('safeCss', () => {
  it('keeps ordinary declarations', () => {
    const css = '.hero { color: #fff; font-size: 2rem; }';
    expect(safeCss(css)).toBe(css);
  });

  it('removes a closing style tag', () => {
    // The whole finding: this is what turns a stylesheet into markup.
    const out = safeCss('body{}</style><script>alert(1)</script>');
    expect(out).not.toContain('</style>');
    expect(out).not.toContain('<script');
  });

  it('removes a closing style tag written oddly', () => {
    // Browsers accept whitespace and mixed case inside the tag.
    expect(safeCss('a{}< / STYLE >x')).not.toMatch(/<\s*\/\s*style/i);
  });

  it('neutralises url() so a stylesheet cannot phone home', () => {
    // background-image: url(https://evil/?t=…) is a tracking pixel that fires
    // on page load and leaks the visitor's IP and referrer.
    expect(safeCss('.a{background:url(https://evil/x)}')).not.toMatch(/\burl\s*\(/);
  });

  it('removes @import', () => {
    expect(safeCss('@import url("https://evil/x.css"); .a{}')).not.toMatch(/@import/i);
  });

  it('removes expression() and javascript:', () => {
    expect(safeCss('.a{width:expression(alert(1))}')).not.toMatch(/expression\s*\(/i);
    expect(safeCss('.a{background:javascript:alert(1)}')).not.toMatch(/javascript:/i);
  });

  it('removes HTML comment delimiters', () => {
    // `<!--` lets a payload hide from the CSS parser while the HTML parser
    // still sees it.
    expect(safeCss('<!-- .a{} -->')).not.toMatch(/<!--|-->/);
  });

  it('returns empty for a non-string or an absurd length', () => {
    expect(safeCss(null)).toBe('');
    expect(safeCss(123)).toBe('');
    expect(safeCss('a'.repeat(70_000))).toBe('');
  });
});

describe('safeImageUrl', () => {
  it('keeps https and relative paths', () => {
    expect(safeImageUrl('https://cdn.example/logo.png')).toBe('https://cdn.example/logo.png');
    expect(safeImageUrl('/static/logo.png')).toBe('/static/logo.png');
  });

  it('refuses javascript:', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBe('');
  });

  it('refuses data: URLs', () => {
    // `data:text/html,…` in an href navigates to attacker-authored markup.
    expect(safeImageUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('refuses anything else with a scheme', () => {
    expect(safeImageUrl('file:///etc/passwd')).toBe('');
    expect(safeImageUrl('vbscript:msgbox(1)')).toBe('');
  });

  it('returns empty for a non-string, empty or absurd value', () => {
    expect(safeImageUrl(null)).toBe('');
    expect(safeImageUrl('  ')).toBe('');
    expect(safeImageUrl(`https://x/${'a'.repeat(2100)}`)).toBe('');
  });
});
