import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The `view/2` renderer (ADR 0042 slice 2), mounted against a live engine.
 *
 * Its unit sibling (`src/lib/view/view-page.test.ts`) answers with object
 * literals. This one asks the engine: the generated columns come from
 * `GET /api/data`, the rows from the data API with the view's filter as its
 * JSON `filter`, the record of a split's second pane from `GET /api/data/:c/:id`
 * — so a change in any of those answers breaks it here.
 */
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/x') } }));

import { api, dataApi } from '#lib/api.js';
import ViewPage from '../../src/lib/view/ViewPage.svelte';

const NAME = `it_view_${Date.now().toString(36)}`;

beforeAll(async () => {
  await api.post('/api/collections', {
    name: NAME,
    display_name: 'View Notes',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'status', type: 'text' },
    ],
  });
  // The table is created by a job; the data API answers once it exists.
  await waitFor(() => dataApi.list(NAME, { limit: 1 }), { timeout: 30_000, interval: 500 });
  await dataApi.create(NAME, { title: 'Alpha note', status: 'open' });
  await dataApi.create(NAME, { title: 'Beta note', status: 'void' });
}, 60_000);

afterAll(async () => {
  await api.delete(`/api/collections/${NAME}`).catch(() => {});
});

afterEach(cleanup);

describe('view/2 renderer — against the engine', () => {
  it('draws the generated columns and applies the filter on the engine', async () => {
    const { container } = render(ViewPage, {
      props: {
        ext: 'none',
        view: {
          type: 'list',
          collection: NAME,
          filter: [{ field: 'status', op: 'neq', value: 'void' }],
          sort: 'title',
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Alpha note'));
    expect(container.textContent).not.toContain('Beta note');
    const heads = [...container.querySelectorAll('th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual(['title', 'status']);
  });

  it('a split pane reads the record selected in the first one', async () => {
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'none',
        view: {
          type: 'split',
          panes: [
            { type: 'list', id: 'notes', collection: NAME, fields: ['title'] },
            {
              type: 'detail',
              collection: NAME,
              record: { $selected: 'notes' },
              fields: ['status'],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Beta note'));
    await fireEvent.click(getByText('Beta note'));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-detail"]')?.textContent).toContain('void'),
    );
  });
});
