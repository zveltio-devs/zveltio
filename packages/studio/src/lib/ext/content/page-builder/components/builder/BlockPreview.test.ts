/**
 * Component test for the page-builder BlockPreview.
 *
 * BlockPreview renders the author's LIVE editor draft with `{@html}` before it
 * is round-tripped through the engine's server-side scrubber, so the three
 * HTML-bearing block types (richtext, columns, embed) must sanitize locally.
 * These tests plant a `<script>` in each and assert the benign markup survives
 * while the script is stripped — a regression guard on the XSS hardening.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import BlockPreview from './BlockPreview.svelte';
import type { Block } from '../../lib/builder-types.js';

const block = (type: string, props: Record<string, unknown>): Block => ({
  id: 'b1',
  type,
  props,
  style: {},
});

describe('BlockPreview sanitization', () => {
  afterEach(() => cleanup());

  it('richtext: keeps formatting but strips <script>', () => {
    const { container } = render(BlockPreview, {
      props: { block: block('richtext', { content: '<p>hello <strong>bold</strong></p><script>alert(1)</script>' }) },
    });
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain('<script');
  });

  it('richtext: shows the placeholder when content is empty', () => {
    const { container } = render(BlockPreview, {
      props: { block: block('richtext', { content: '' }) },
    });
    expect(container.textContent).toContain('Rich text');
  });

  it('columns: strips <script> from each column', () => {
    const { container } = render(BlockPreview, {
      props: { block: block('columns', { items: ['<em>col</em><script>steal()</script>'] }) },
    });
    expect(container.querySelector('em')?.textContent).toBe('col');
    expect(container.querySelector('script')).toBeNull();
  });

  it('embed: strips <script> from raw HTML', () => {
    const { container } = render(BlockPreview, {
      props: { block: block('embed', { html: '<b>widget</b><script>pwn()</script>' }) },
    });
    expect(container.querySelector('b')?.textContent).toBe('widget');
    expect(container.querySelector('script')).toBeNull();
  });

  it('embed: drops a javascript: href (disallowed scheme)', () => {
    const { container } = render(BlockPreview, {
      props: { block: block('embed', { html: '<a href="javascript:alert(1)">x</a>' }) },
    });
    expect(container.innerHTML.toLowerCase()).not.toContain('javascript:');
  });
});
