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
const post = vi.fn(
  async (_url: string, _body: unknown): Promise<unknown> => ({ result: { total: 3 } }),
);

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
    delete: async (collection: string, id: string) => {
      calls.push(`DELETE ${collection}/${id}`);
    },
  },
}));

beforeEach(() => {
  calls.length = 0;
  post.mockClear();
  post.mockImplementation(async () => ({ result: { total: 3 } }));
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

  it('a toolbar button whose input names an unselected pane is disabled, never sent', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'split',
          panes: [
            { type: 'list', id: 'notes', collection: 'notes', fields: ['title'] },
            {
              type: 'list',
              collection: 'notes',
              fields: ['status'],
              actions: [
                { action: 'archive', label: 'Dismiss all', input: { note_id: { $selected: 'notes' } } },
              ],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('First'));
    const button = () => getByText('Dismiss all').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(button()).toBeTruthy());
    expect(button().disabled).toBe(true);
    await fireEvent.click(button());
    expect(post).not.toHaveBeenCalled();
    await fireEvent.click(getByText('First'));
    await waitFor(() => expect(button().disabled).toBe(false));
    await fireEvent.click(button());
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/notes/actions/archive', { note_id: 'n1' }),
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
      // A kind of a later `view/2` than this Studio knows.
      props: { ext: 'notes', view: { type: 'gallery', collection: 'notes' } as never },
    });
    await waitFor(() => expect(container.textContent).toContain('First'));
    expect(container.querySelector('[data-testid="view-not-drawn"]')).toBeTruthy();
  }, 60_000);

  it('a toolbar button with `when` has no record to hold of: hidden', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          title: 'Notes',
          actions: [
            { action: 'archive', label: 'Always' },
            {
              action: 'archive',
              label: 'Only if',
              when: [{ field: 'status', op: 'eq', value: 'open' }],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Always'));
    expect(container.textContent).not.toContain('Only if');
  }, 60_000);

  it('a button is held until its confirmed action settles: no double submit', async () => {
    let finish: (v: unknown) => void = () => {};
    post.mockImplementation(() => new Promise<unknown>((r) => (finish = r)));
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { getByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          title: 'Notes',
          actions: [{ action: 'archive', label: 'Go', confirm: 'Sure?' }],
        },
      },
    });
    const go = () => getByText('Go') as HTMLButtonElement;
    await waitFor(() => expect(go()).toBeTruthy());
    await fireEvent.click(go());
    // Held while the confirm dialog is open, and after it, while the action runs.
    expect(go().disabled).toBe(true);
    const confirm = await waitFor(() => {
      const b = [...document.body.querySelectorAll('button')].find(
        (x) => x.textContent?.trim() === 'Confirm',
      );
      if (!b) throw new Error('no confirm button');
      return b;
    });
    await fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(go().disabled).toBe(true);
    await fireEvent.click(go());
    finish({ result: null });
    await waitFor(() => expect(go().disabled).toBe(false));
    expect(post).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('`edit` opens the row in the generated form; `delete` deletes it after a confirm', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { getAllByText, container } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: { type: 'list', collection: 'notes', edit: true, delete: true },
      },
    });
    await waitFor(() => expect(container.textContent).toContain('Second'));
    await fireEvent.click(getAllByText('Delete')[0] as HTMLElement);
    expect(calls).not.toContain('DELETE notes/n1');
    // The confirm dialog's own button is the last "Delete" on the page.
    const confirm = await waitFor(() => {
      const all = getAllByText('Delete');
      if (all.length <= rows.length) throw new Error('no confirm button');
      return all[all.length - 1] as HTMLElement;
    });
    await fireEvent.click(confirm);
    await waitFor(() => expect(calls).toContain('DELETE notes/n1'));
    await fireEvent.click(getAllByText('Edit')[1] as HTMLElement);
    await waitFor(() => expect(calls).toContain('GET notes/n2'));
  }, 60_000);

  it('an action-sourced stat runs once, only if the caller may run it', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'split',
          panes: [
            { type: 'stat', source: { action: 'archive' } },
            { type: 'stat', source: { action: 'purge' } },
            {
              type: 'list',
              collection: 'notes',
              title: 'Notes',
              actions: [{ action: 'archive', label: 'Bump' }],
            },
          ],
        },
      },
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe('/ext/notes/actions/archive');
    // Another action ran (`host.version` moved): the stat does not run its action again.
    await fireEvent.click(getByText('Bump'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.some(([u]) => u === '/ext/notes/actions/purge')).toBe(false);
    void container;
  }, 60_000);
});
