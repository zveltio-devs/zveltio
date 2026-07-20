/**
 * Tests for the Studio HTML sanitizer used at every `{@html}` call site
 * (page-builder preview, rich-text blocks). This is a privilege-escalation
 * boundary — an editor's HTML runs in the admin's session on preview — so
 * the allow-list and URL-scheme rules are worth locking down with tests.
 */

import { describe, it, expect } from 'vitest';
import { safeHtml, safeIframeSrc, safeCssColor } from './sanitize';

describe('safeHtml', () => {
  it('returns empty string for non-strings and empties', () => {
    expect(safeHtml(null)).toBe('');
    expect(safeHtml(undefined)).toBe('');
    expect(safeHtml(123)).toBe('');
    expect(safeHtml('')).toBe('');
  });

  it('keeps allow-listed formatting tags', () => {
    const out = safeHtml('<p>Hello <strong>world</strong> <a href="https://x.com">link</a></p>');
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('href="https://x.com"');
  });

  it('strips <script> entirely', () => {
    const out = safeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out.toLowerCase()).not.toContain('<script');
  });

  it('removes inline event-handler attributes', () => {
    const out = safeHtml('<img src="https://x/i.png" onerror="alert(1)">');
    expect(out.toLowerCase()).not.toContain('onerror');
  });

  it('drops javascript: hrefs (disallowed URI scheme)', () => {
    const out = safeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('strips non-allow-listed tags like iframe/object', () => {
    const out = safeHtml('<iframe src="https://evil"></iframe><object></object>');
    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out.toLowerCase()).not.toContain('<object');
  });
});

describe('safeIframeSrc', () => {
  it('passes through http(s) URLs', () => {
    expect(safeIframeSrc('https://youtube.com/embed/x')).toBe('https://youtube.com/embed/x');
    expect(safeIframeSrc('http://example.com')).toBe('http://example.com');
  });

  it('upgrades protocol-relative URLs to https', () => {
    expect(safeIframeSrc('//example.com/x')).toBe('https://example.com/x');
  });

  it('collapses dangerous schemes to about:blank', () => {
    expect(safeIframeSrc('javascript:alert(1)')).toBe('about:blank');
    expect(safeIframeSrc('data:text/html,<script>alert(1)</script>')).toBe('about:blank');
    expect(safeIframeSrc('')).toBe('about:blank');
    expect(safeIframeSrc(null)).toBe('about:blank');
  });
});

describe('safeCssColor', () => {
  it('accepts valid color forms', () => {
    expect(safeCssColor('#fff', 'black')).toBe('#fff');
    expect(safeCssColor('#aabbcc', 'black')).toBe('#aabbcc');
    expect(safeCssColor('rgb(1,2,3)', 'black')).toBe('rgb(1,2,3)');
    expect(safeCssColor('rebeccapurple', 'black')).toBe('rebeccapurple');
  });

  it('rejects CSS-injection payloads, returning the fallback', () => {
    expect(safeCssColor('red; background-image: url(https://evil/track)', 'black')).toBe('black');
    expect(safeCssColor('x'.repeat(200), 'black')).toBe('black');
    expect(safeCssColor(42, 'black')).toBe('black');
  });
});
