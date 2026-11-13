/**
 * Page-builder value sanitisers.
 *
 * Svelte escapes interpolated values for HTML, which is not the same as escaping
 * them for the context they land in. Inside a `style="..."` attribute the
 * grammar is CSS, where `;` starts a new declaration; inside `<iframe src>` a
 * `javascript:` URL executes in the current origin. Both fields are typed by a
 * page-builder author, so both are an editor-to-admin escalation: the payload
 * fires when an admin opens the preview.
 */

import { describe, expect, it } from 'vitest';
import { safeCssColor, safeCssNumber, safeIframeSrc } from './sanitize.js';

describe('safeCssColor', () => {
  it('passes the colour notations blocks actually use', () => {
    expect(safeCssColor('#fff', 'x')).toBe('#fff');
    expect(safeCssColor('#1e293b', 'x')).toBe('#1e293b');
    expect(safeCssColor('#11223344', 'x')).toBe('#11223344');
    expect(safeCssColor('rgb(1,2,3)', 'x')).toBe('rgb(1,2,3)');
    expect(safeCssColor('rgba(1,2,3,0.5)', 'x')).toBe('rgba(1,2,3,0.5)');
    expect(safeCssColor('hsl(200, 50%, 40%)', 'x')).toBe('hsl(200, 50%, 40%)');
    expect(safeCssColor('rebeccapurple', 'x')).toBe('rebeccapurple');
  });

  it('rejects a value that closes the declaration and adds another', () => {
    // The tracking-pixel payload: fires on preview, leaks the admin's IP.
    expect(safeCssColor('red; background-image: url(https://evil/track?id=1)', '#000')).toBe(
      '#000',
    );
  });

  it('rejects a url() even without a semicolon', () => {
    expect(safeCssColor('url(https://evil/x)', '#000')).toBe('#000');
  });

  it('rejects expression-like and escaped payloads', () => {
    expect(safeCssColor('expression(alert(1))', '#000')).toBe('#000');
    expect(safeCssColor('\\75 rl(https://evil)', '#000')).toBe('#000');
  });

  it('falls back for non-strings, empties and absurd lengths', () => {
    expect(safeCssColor(undefined, '#000')).toBe('#000');
    expect(safeCssColor(null, '#000')).toBe('#000');
    expect(safeCssColor(42, '#000')).toBe('#000');
    expect(safeCssColor('   ', '#000')).toBe('#000');
    expect(safeCssColor('a'.repeat(101), '#000')).toBe('#000');
  });
});

describe('safeCssNumber', () => {
  it('keeps a number in range', () => {
    expect(safeCssNumber(24, 48, 0, 2000)).toBe(24);
    expect(safeCssNumber('24', 48, 0, 2000)).toBe(24);
  });

  it('clamps out-of-range values instead of emitting them', () => {
    expect(safeCssNumber(999999, 48, 0, 2000)).toBe(2000);
    expect(safeCssNumber(-5, 48, 0, 2000)).toBe(0);
  });

  it('falls back rather than letting a string through', () => {
    // `48px; background: url(...)` is the same injection as the colour one.
    expect(safeCssNumber('48px; background: url(https://evil)', 48, 0, 2000)).toBe(48);
    expect(safeCssNumber('nope', 48, 0, 2000)).toBe(48);
    expect(safeCssNumber(undefined, 48, 0, 2000)).toBe(48);
    expect(safeCssNumber(Number.NaN, 48, 0, 2000)).toBe(48);
    expect(safeCssNumber(Number.POSITIVE_INFINITY, 48, 0, 2000)).toBe(48);
  });
});

describe('safeIframeSrc', () => {
  it('allows http(s) and upgrades protocol-relative', () => {
    expect(safeIframeSrc('https://youtube.com/embed/x')).toBe('https://youtube.com/embed/x');
    expect(safeIframeSrc('http://example.com/v')).toBe('http://example.com/v');
    expect(safeIframeSrc('//youtube.com/embed/x')).toBe('https://youtube.com/embed/x');
  });

  it('collapses script-bearing schemes to about:blank', () => {
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(safeIframeSrc(bad)).toBe('about:blank');
    }
  });

  it('collapses empty and non-string input', () => {
    expect(safeIframeSrc('')).toBe('about:blank');
    expect(safeIframeSrc(undefined)).toBe('about:blank');
    expect(safeIframeSrc(null)).toBe('about:blank');
    expect(safeIframeSrc(123)).toBe('about:blank');
  });
});
