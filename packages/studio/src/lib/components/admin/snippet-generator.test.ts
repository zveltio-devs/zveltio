/**
 * A rejected clipboard write must not report a copy.
 *
 * `writeText` rejects without a secure context or the permission. The tick was
 * set unconditionally, so the user saw "copied" over an empty clipboard — the
 * same defect repaired in `SettingsPage.copy` during C03.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';

const errors: string[] = [];
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: (msg: string) => errors.push(msg), success: () => {} },
}));

import SnippetGenerator from './SnippetGenerator.svelte';

afterEach(() => {
  cleanup();
  errors.length = 0;
});

function copyButton(): HTMLElement {
  const buttons = screen.getAllByRole('button');
  return buttons[buttons.length - 1];
}

describe('SnippetGenerator copy', () => {
  it('reports the failure and shows no tick when the clipboard rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    const { container } = render(SnippetGenerator, { props: { collectionName: 'orders' } });
    copyButton().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['Could not copy to clipboard.']);
    expect(container.querySelector('.text-success')).toBeNull();
  });

  it('shows the tick when the write resolves', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
    const { container } = render(SnippetGenerator, { props: { collectionName: 'orders' } });
    copyButton().click();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
    expect(container.querySelector('.text-success')).not.toBeNull();
  });
});
