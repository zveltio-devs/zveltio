/**
 * Component test for the public page-builder renderer.
 *
 * BlockRenderer maps published `blocks: [{ type, content }]` to markup. The
 * `text` and `html` block types render authored HTML with `{@html}`, guarded by
 * safeHtml() (DOMPurify). These tests plant a `<script>` in each and assert the
 * benign markup renders while the script is stripped — the public-surface
 * regression guard for the CMS XSS hardening. It also pins the forward-compat
 * contract: an unknown block type degrades to a visible placeholder, never a
 * crash.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import BlockRenderer from './BlockRenderer.svelte';

const blocks = (b: any[]) => ({ props: { blocks: b } });

describe('BlockRenderer', () => {
  afterEach(() => cleanup());

  it('author-typed link and embed URLs never carry javascript:', () => {
    const js = 'javascript:alert(1)';
    const { container } = render(
      BlockRenderer,
      blocks([
        { type: 'hero', content: { title: 't', cta_text: 'go', cta_url: js } },
        { type: 'button', content: { text: 'b', href: js } },
        { type: 'image', content: { url: 'https://x.test/a.png', link: js } },
        { type: 'video', content: { url: js } },
      ]),
    );
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.every((h) => h === '#')).toBe(true);
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('text block: keeps formatting but strips <script>', () => {
    const { container } = render(
      BlockRenderer,
      blocks([
        {
          type: 'text',
          content: { html: '<p>hi <strong>there</strong></p><script>alert(1)</script>' },
        },
      ]),
    );
    expect(container.querySelector('strong')?.textContent).toBe('there');
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain('<script');
  });

  it('html block: strips <script> from raw HTML', () => {
    const { container } = render(
      BlockRenderer,
      blocks([{ type: 'html', content: { code: '<b>widget</b><script>pwn()</script>' } }]),
    );
    expect(container.querySelector('b')?.textContent).toBe('widget');
    expect(container.querySelector('script')).toBeNull();
  });

  it('text block: removes inline event-handler attributes', () => {
    const { container } = render(
      BlockRenderer,
      blocks([
        { type: 'text', content: { html: '<img src="https://x/i.png" onerror="alert(1)">' } },
      ]),
    );
    expect(container.innerHTML.toLowerCase()).not.toContain('onerror');
  });

  it('heading block: renders text content (no HTML injection surface)', () => {
    const { getByText } = render(
      BlockRenderer,
      blocks([{ type: 'heading', content: { level: 2, text: 'Welcome' } }]),
    );
    expect(getByText('Welcome')).toBeInTheDocument();
  });

  it('unknown block type degrades to a visible placeholder', () => {
    const { getByText } = render(BlockRenderer, blocks([{ type: 'quantum', content: {} }]));
    expect(getByText(/Unsupported block: quantum/)).toBeInTheDocument();
  });
});
