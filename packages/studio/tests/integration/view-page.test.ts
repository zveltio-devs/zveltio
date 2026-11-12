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
/** Slice 4: a timeline with an end, and a board that moves. */
const EVENTS = `it_events_${Date.now().toString(36)}`;
/** A tree with an order: a move is one bulk write. */
const OUTLINE = `it_outline_${Date.now().toString(36)}`;
const p2 = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const TODAY = day(new Date());

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

  await api.post('/api/collections', {
    name: EVENTS,
    display_name: 'View Events',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'status', type: 'text' },
      { name: 'starts', type: 'date' },
      { name: 'ends', type: 'date' },
    ],
  });
  await waitFor(() => dataApi.list(EVENTS, { limit: 1 }), { timeout: 30_000, interval: 500 });
  await dataApi.create(EVENTS, { title: 'Open ended', status: 'todo', starts: TODAY, ends: null });
  await dataApi.create(EVENTS, { title: 'One day', status: 'todo', starts: TODAY, ends: TODAY });
  await dataApi.create(EVENTS, {
    title: 'Long ago',
    status: 'done',
    starts: '2001-01-01',
    ends: '2001-01-02',
  });

  await api.post('/api/collections', {
    name: OUTLINE,
    display_name: 'View Outline',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'parent', type: 'text' },
      { name: 'pos', type: 'integer' },
    ],
  });
  await waitFor(() => dataApi.list(OUTLINE, { limit: 1 }), { timeout: 30_000, interval: 500 });
  await dataApi.create(OUTLINE, { title: 'First', pos: 1 });
  await dataApi.create(OUTLINE, { title: 'Second', pos: 2 });
}, 60_000);

afterAll(async () => {
  await api.delete(`/api/collections/${NAME}`).catch(() => {});
  await api.delete(`/api/collections/${EVENTS}`).catch(() => {});
  await api.delete(`/api/collections/${OUTLINE}`).catch(() => {});
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

  it('a timeline with an end shows a record whose end is empty: the engine takes both queries', async () => {
    const { container } = render(ViewPage, {
      props: {
        ext: 'none',
        view: { type: 'timeline', collection: EVENTS, start: 'starts', end: 'ends', scale: 'day' },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Open ended'));
    expect(container.textContent).toContain('One day');
    expect(container.textContent).not.toContain('Long ago');
  });

  it('a board move writes the new column through the data API', async () => {
    const { container } = render(ViewPage, {
      props: {
        ext: 'none',
        view: {
          type: 'board',
          collection: EVENTS,
          groupBy: 'status',
          card: ['title'],
          move: 'patch',
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Open ended'));
    const card = [...container.querySelectorAll('[data-column="todo"] li')].find((li) =>
      li.textContent?.includes('Open ended'),
    ) as HTMLElement;
    await fireEvent.change(card.querySelector('select') as HTMLSelectElement, {
      target: { value: 'done' },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-column="done"]')?.textContent).toContain('Open ended'),
    );
    const moved = (
      await dataApi.list(EVENTS, { filter: JSON.stringify({ title: { eq: 'Open ended' } }) })
    ).records[0];
    expect(moved.status).toBe('done');
  });

  it('a tree "Move up" stores both orders in one bulk write', async () => {
    const { container } = render(ViewPage, {
      props: {
        ext: 'none',
        view: {
          type: 'tree',
          collection: OUTLINE,
          parent: 'parent',
          label: 'title',
          order: 'pos',
          move: 'patch',
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Second'));
    const second = (
      await dataApi.list(OUTLINE, { filter: JSON.stringify({ title: { eq: 'Second' } }) })
    ).records[0];
    await fireEvent.click(
      container.querySelector(`[data-node="${second.id}"] [aria-label="Move up"]`) as HTMLElement,
    );
    await waitFor(
      async () => {
        const rows = (await dataApi.list(OUTLINE, { sort: 'pos', order: 'asc' })).records;
        expect(rows.map((r) => [r.title, r.pos])).toEqual([
          ['Second', 1],
          ['First', 2],
        ]);
      },
      { timeout: 10_000 },
    );
  });
});
