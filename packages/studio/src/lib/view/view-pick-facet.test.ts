import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR-45: a relation drawn as a picker (a collection form's `m2o`, an action
 * input named by `pick`, in a button's prompt and in an action form) and a
 * list's `facets` as quick filters, against a mocked engine.
 */
const people = [
  { id: 'p1', name: 'Alice' },
  { id: 'p2', name: 'Bob' },
];
const calls: string[] = [];
const post = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({ result: null }));
const create = vi.fn(async (_c: string, d: unknown) => ({ id: 'n9', ...(d as object) }));
let noteRecord: Record<string, unknown> = { id: 'n1', title: 'First', owner: 'p1' };

vi.mock('#lib/api.js', () => ({
  api: {
    get: async (url: string) => {
      if (url === '/api/data') {
        return {
          collections: [
            {
              name: 'notes',
              fields: [
                { name: 'title', type: 'text' },
                {
                  name: 'status',
                  type: 'select',
                  options: { choices: ['todo', 'doing', { value: 'done', label: 'Done!' }] },
                },
                { name: 'done', type: 'boolean' },
                { name: 'owner', type: 'm2o', options: { related_collection: 'people' } },
              ],
            },
            { name: 'people', fields: [{ name: 'name', type: 'text' }] },
          ],
        };
      }
      if (url === '/api/actions') {
        return {
          actions: [
            {
              extension: 'notes',
              name: 'assign',
              input: { properties: { assignee: { type: 'string' }, reason: { type: 'string' } } },
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    },
    post: (url: string, body: unknown) => post(url, body),
  },
  dataApi: {
    list: async (collection: string, params: Record<string, unknown>) => {
      calls.push(`LIST ${collection} ${JSON.stringify(params)}`);
      if (collection === 'people') {
        const filter = JSON.parse(String(params.filter ?? '{}')) as { id?: { in?: string[] } };
        const q = String(params.search ?? '').toLowerCase();
        const found = people
          .filter((p) => !filter.id?.in || filter.id.in.includes(p.id))
          .filter((p) => p.name.toLowerCase().includes(q));
        return { records: found, pagination: { total: found.length } };
      }
      return { records: [noteRecord], pagination: { total: 1 } };
    },
    get: async () => noteRecord,
    create: (c: string, d: unknown) => create(c, d),
  },
}));

beforeEach(() => {
  calls.length = 0;
  post.mockClear();
  create.mockClear();
  noteRecord = { id: 'n1', title: 'First', owner: 'p1' };
});
afterEach(cleanup);

describe('relation input (picker)', () => {
  it("a button's prompt draws a `pick` input as a picker: search as the user, store the id", async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText, getByTestId } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          fields: ['title'],
          actions: [
            {
              action: 'assign',
              label: 'Assign',
              prompt: ['assignee', 'reason'],
              pick: { assignee: 'people' },
            },
          ],
        },
      },
    });
    await waitFor(() => expect(getByText('Assign')).toBeTruthy());
    await fireEvent.click(getByText('Assign'));
    const doc = container.ownerDocument;
    await waitFor(() => expect(doc.querySelector('[data-testid="view-picker"]')).toBeTruthy());
    // The other prompt input stays a text box; the picked one is not.
    expect(doc.querySelectorAll('[data-testid="view-picker"]').length).toBe(1);
    expect(
      doc.querySelector('input[id$="prompt:reason"], #field-view\\:notes\\:prompt-reason'),
    ).toBeTruthy();
    const search = doc.querySelector('[data-testid="view-picker"] input') as HTMLInputElement;
    await fireEvent.input(search, { target: { value: 'ali' } });
    await waitFor(() =>
      expect(calls).toContain('LIST people {"page":1,"limit":20,"search":"ali"}'),
    );
    await waitFor(() => expect(getByText('Alice')).toBeTruthy());
    expect(doc.body.textContent).not.toContain('Bob');
    await fireEvent.click(getByText('Alice'));
    await waitFor(() => expect(getByTestId('view-picker-current').textContent).toBe('Alice'));
    await fireEvent.click(getByText('Confirm'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/notes/actions/assign', { assignee: 'p1' }),
    );
  }, 60_000);

  it('a collection form draws an m2o field as a picker and saves the picked id', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: { ext: 'notes', view: { type: 'form', collection: 'notes', fields: ['owner'] } },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-picker"]')).toBeTruthy(),
    );
    // Not a text box of the id.
    expect(container.querySelectorAll('input').length).toBe(1);
    await fireEvent.focus(container.querySelector('[data-testid="view-picker"] input') as Element);
    await waitFor(() => expect(getByText('Bob')).toBeTruthy());
    await fireEvent.click(getByText('Bob'));
    await fireEvent.click(getByText('Save'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('notes', { owner: 'p2' }));
  }, 60_000);

  it('a value the caller cannot read keeps its id', async () => {
    noteRecord = { id: 'n1', title: 'First', owner: 'gone' };
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, {
      props: {
        ext: 'notes',
        params: { id: 'n1' },
        view: { type: 'form', collection: 'notes', record: { $param: 'id' }, fields: ['owner'] },
      },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-picker-current"]')?.textContent).toBe(
        'gone',
      ),
    );
    expect(calls.some((c) => c.startsWith('LIST people') && c.includes('gone'))).toBe(true);
  }, 60_000);

  it('an action form draws a `pick` input as a picker; the others stay text', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container, getByText } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: { type: 'form', action: 'assign', pick: { assignee: 'people' } },
      },
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="view-picker"]')).toBeTruthy(),
    );
    expect(container.querySelectorAll('[data-testid="view-picker"]').length).toBe(1);
    await fireEvent.focus(container.querySelector('[data-testid="view-picker"] input') as Element);
    await waitFor(() => expect(getByText('Alice')).toBeTruthy());
    await fireEvent.click(getByText('Alice'));
    await fireEvent.click(getByText('Save'));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/notes/actions/assign', { assignee: 'p1' }),
    );
  }, 60_000);
});

describe('filter facet', () => {
  const listCalls = () => calls.filter((c) => c.startsWith('LIST notes'));
  const lastFilter = () => {
    const last = listCalls().at(-1) as string;
    return JSON.parse(JSON.parse(last.slice('LIST notes '.length)).filter ?? '{}');
  };

  it('draws all and one button per choice (yes and no for a boolean); a pick adds `eq` to the query', async () => {
    const { default: ViewPage } = await import('./ViewPage.svelte');
    const { container } = render(ViewPage, {
      props: {
        ext: 'notes',
        view: {
          type: 'list',
          collection: 'notes',
          fields: ['title'],
          filter: [{ field: 'title', op: 'neq', value: 'void' }],
          facets: ['status', 'done'],
        },
      },
    });
    const facet = (field: string) =>
      container.querySelector(`[data-testid="view-facet"][data-field="${field}"]`) as HTMLElement;
    const button = (field: string, text: string) =>
      [...facet(field).querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === text,
      ) as HTMLElement;
    await waitFor(() => expect(facet('status')).toBeTruthy());
    await waitFor(() => expect(facet('status').querySelectorAll('button').length).toBe(4));
    expect(
      [...facet('status').querySelectorAll('button')].map((b) => b.textContent?.trim()),
    ).toEqual(['All', 'todo', 'doing', 'Done!']);
    expect([...facet('done').querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(
      ['All', 'Yes', 'No'],
    );
    // Nothing picked: the view's own filter only.
    expect(lastFilter()).toEqual({ title: { neq: 'void' } });

    await fireEvent.click(button('status', 'doing'));
    await waitFor(() =>
      expect(lastFilter()).toEqual({ title: { neq: 'void' }, status: { eq: 'doing' } }),
    );
    // One value per facet at a time; facets combine.
    await fireEvent.click(button('status', 'Done!'));
    await fireEvent.click(button('done', 'No'));
    await waitFor(() =>
      expect(lastFilter()).toEqual({
        title: { neq: 'void' },
        status: { eq: 'done' },
        done: { eq: false },
      }),
    );
    await fireEvent.click(button('status', 'All'));
    await waitFor(() =>
      expect(lastFilter()).toEqual({ title: { neq: 'void' }, done: { eq: false } }),
    );
  }, 60_000);
});
