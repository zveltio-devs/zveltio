import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The checkboxes on the file cards selected files and nothing else.
 *
 * `bulkDelete` existed and was never called from anywhere in the markup, so an
 * operator could tick thirty files and find no button to act on them. The
 * selection now has an action, and — unlike the single-file delete, which did
 * ask — that action asks before removing anything.
 *
 * A failed load is the second half: the `catch` set `files = []` and fell
 * through to the empty state, so a 403 or a storage driver that was down read
 * as "no files have ever been uploaded".
 */
const { get, del } = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    files: [
      {
        id: 'f1',
        original_name: 'a.png',
        mime_type: 'image/png',
        size: 10,
        url: '/a',
        created_at: '2026-01-01',
      },
      {
        id: 'f2',
        original_name: 'b.pdf',
        mime_type: 'application/pdf',
        size: 20,
        url: '/b',
        created_at: '2026-01-01',
      },
    ],
  })),
  del: vi.fn(async () => ({})),
}));

vi.mock('$lib/api.js', () => ({ api: { get, delete: del, fetch: vi.fn() } }));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$lib/clipboard.js', () => ({ copyText: vi.fn(async () => true) }));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('storage — selection', () => {
  it('asks before deleting the selected files, and deletes them on confirm', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('a.png'));

    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    for (const b of boxes) b.click();

    // The selection bar's button, not a card's — the cards carry `btn-xs`.
    const bulk = await waitFor(() => {
      const b = container.querySelector('button.btn-error.btn-sm');
      if (!b) throw new Error('no bulk delete button');
      return b as HTMLButtonElement;
    });
    bulk.click();

    // The confirmation is up and nothing has been deleted yet.
    await waitFor(() => expect(document.body.textContent).toMatch(/2/));
    expect(del).not.toHaveBeenCalled();

    const confirm = [...document.querySelectorAll('.modal button, dialog button')].find((b) =>
      /delete|șterge/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    confirm.click();

    await waitFor(() => expect(del).toHaveBeenCalledTimes(2));
  });

  it('says the load failed instead of showing the empty state', async () => {
    get.mockRejectedValueOnce(new Error('Admin access required'));
    render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Admin access required'));
    expect(document.body.textContent).not.toMatch(/no files yet/i);
  });
});
