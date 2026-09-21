import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Two things the panel grid did not do.
 *
 * The card was written `class="col-span-{Math.min(p.width, 12)}"`. Tailwind
 * generates the classes it can see as whole strings in the source, so that one
 * never existed in the stylesheet and every panel drew at the grid's default
 * width — the width chosen when the panel was created was simply ignored.
 *
 * And deleting a panel — someone's query, and its place on the board — went
 * straight through, on a screen where deleting the dashboard around it asked
 * first.
 */
const { get, del, post } = vi.hoisted(() => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/insights/dashboards') {
      return {
        dashboards: [
          {
            id: 'd1',
            name: 'Ops',
            icon: 'BarChart',
            is_default: true,
            panel_count: 1,
            created_at: '2026-01-01',
          },
        ],
      };
    }
    return {
      panels: [
        {
          id: 'p1',
          name: 'Orders',
          type: 'table',
          query: 'SELECT 1',
          config: {},
          position_x: 0,
          position_y: 0,
          width: 4,
          height: 4,
        },
      ],
    };
  }),
  del: vi.fn(async () => ({})),
  post: vi.fn(async () => ({ data: [] })),
}));

vi.mock('$lib/api.js', () => ({ api: { get, post, delete: del, fetch: vi.fn() } }));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('insights — panels', () => {
  it('draws a panel at the width it was given', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Orders'));

    const card = container.querySelector('.card[style*="grid-column"]') as HTMLElement;
    expect(card.getAttribute('style')).toContain('span 4');
  });

  it('asks before deleting a panel', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Orders'));

    const remove = container.querySelector('button.btn-xs.btn-error') as HTMLButtonElement;
    remove.click();

    await waitFor(() => expect(document.body.textContent).toMatch(/Orders/));
    expect(del).not.toHaveBeenCalled();

    const confirm = [...document.querySelectorAll('.modal button, dialog button')].find((b) =>
      /delete|șterge/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    confirm.click();

    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/insights/panels/p1'));
  });
});
