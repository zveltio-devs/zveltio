import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `view/2` renderer against a mocked engine: what it asks for (names turned
 * into data API and action calls as the signed-in user) and what it draws.
 * `tests/integration/view-page.test.ts` runs the same renderer on a live engine.
 */
const rows = [
  { id: 'n1', title: 'First', status: 'open', body: '<img src=x onerror=alert(1)>' },
  { id: 'n2', title: 'Second', status: 'done', body: 'plain' },
];
const calls: string[] = [];
const post = vi.fn(async (_url: string, _body: unknown) => ({ result: { total: 3 } }));

vi.mock('#lib/api.js', () => ({
  api: {
    get: async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === '/api/data') {
        return {
          collections: [
            {
              name: 'notes',
              fields: [
                { name: 'title', type: 'text' },
                { name: 'status', type: 'text' },
                { name: 'body', type: 'richtext' },
              ],
            },
          ],
        };
      }
      if (url === '/api/actions')
        return { actions: [{ extension: 'notes', name: 'archive', input: {} }] };
      throw new Error(`unexpected ${url}`);
    },
    post: (url: string, body: unknown) => post(url, body),
  },
  dataApi: {
    list: async (collection: string, params: Record<string, unknown>) => {
      calls.push(`LIST ${collection} ${JSON.stringify(params)}`);
      return { records: rows, pagination: { total: rows.length } };
    },
    get: async (collection: string, id: string) => {
      calls.push(`GET ${collection}/${id}`);
      return rows.find((r) => r.id === id);
    },
  },
}));

beforeEach(async () => {
  calls.length = 0;
  post.mockClear();
  const { forgetSchema, forgetActions } = await import('./engine.js');
  forgetSchema();
  forgetActions();
});
afterEach(cleanup);

describe('view/2 renderer', () => {
  it('draws a list with the generated columns, filtered through the data API', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          filter: [{ field: 'status', op: 'neq', value: 'void' }],
          sort: '-title',
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Second'));
    // No `fields`: the collection's default columns, in schema order.
    const heads = [...container.querySelectorAll('th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual(['title', 'status', 'body']);
    expect(calls).toContain(
      'LIST notes {"page":1,"limit":25,"filter":"{\\"status\\":{\\"neq\\":\\"void\\"}}","sort":"title","order":"desc"}',
    );
    // Untrusted rich text is text, never markup.
    expect(container.querySelector('img')).toBeNull();
  }, 60_000);

  it('a split pane waits for a selection, then reads the selected record', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'split',
          panes: [
            { type: 'list', id: 'notes', collection: 'notes', fields: ['title'] },
            {
              type: 'detail',
              collection: 'notes',
              record: { $selected: 'notes' },
              fields: ['status'],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('First'));
    expect(container.querySelector('[data-testid="view-detail"]')?.textContent).not.toContain(
      'open',
    );
    await fireEvent.click(getByText('First'));
    await waitFor(() => expect(calls).toContain('GET notes/n1'));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-detail"]')?.textContent).toContain('open'),
    );
  }, 60_000);

  it('runs a row action as the user, with its input filled from the row', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getAllByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          fields: ['title'],
          rowActions: [
            { action: 'archive', label: 'Archive', input: { note_id: { $record: 'id' } } },
            // Not runnable for this caller (`GET /api/actions` does not list it): not drawn.
            { action: 'purge', label: 'Purge' },
            {
              action: 'archive',
              label: 'Reopen',
              when: [{ field: 'status', op: 'eq', value: 'done' }],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(getAllByText('Archive')).toHaveLength(2));
    expect(container.textContent).not.toContain('Purge');
    expect(getAllByText('Reopen')).toHaveLength(1);
    await fireEvent.click(getAllByText('Archive')[0]);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/notes/actions/archive', { note_id: 'n1' }),
    );
  }, 60_000);

  it('falls back to the generated list for a kind it does not draw', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, {
      props: { ext: 'notes', view: { type: 'board', collection: 'notes', groupBy: 'status' } },
    });
    await waitFor(() => expect(container.textContent).toContain('First'));
    expect(container.querySelector('[data-testid="view-not-drawn"]')).toBeTruthy();
  }, 60_000);
});
