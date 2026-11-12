import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localDay, period, shiftDays } from './engine.js';

/**
 * The `view/2` kinds of ADR 0042 slice 4 (`board`, `timeline`, `tree`,
 * `matrix`, `map`) against a mocked engine: they read through the data API and
 * write a move or an edit through the data API or the view's action, as the
 * list renderer does. `view-page.test.ts` covers the slice 2 kinds.
 */
const today = localDay(new Date());
const month = period(today, 'month');
const other = month.find((d) => d !== today) as string;

const tables: Record<string, Record<string, unknown>[]> = {
  tasks: [
    { id: 't1', title: 'Write spec', status: 'todo', due: today, parent_id: null },
    { id: 't2', title: 'Review', status: 'doing', due: today, parent_id: 't1' },
    { id: 't3', title: 'Ship', status: 'archived', due: null, parent_id: 't2' },
  ],
  grants: [
    { id: 'g1', role: 'admin', perm: 'read', allowed: true },
    { id: 'g2', role: 'editor', perm: 'write', allowed: false },
  ],
  places: [
    { id: 'p1', name: 'Office', at: { lat: 44.43, lng: 26.1 } },
    { id: 'p2', name: 'Nowhere', at: null },
  ],
};
const calls: string[] = [];
const update = vi.fn(async (_c: string, _id: string, _d: unknown) => ({}));
const create = vi.fn(async (_c: string, _d: unknown) => ({}));
const post = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({ result: null }));

vi.mock('#lib/api.js', () => ({
  api: {
    get: async (url: string) => {
      if (url === '/api/data') {
        return {
          collections: [
            {
              name: 'tasks',
              fields: [
                { name: 'title', type: 'text' },
                {
                  name: 'status',
                  type: 'select',
                  options: { choices: ['todo', 'doing', { value: 'done', label: 'Done!' }] },
                },
                { name: 'due', type: 'date' },
                { name: 'parent_id', type: 'reference' },
              ],
            },
            {
              name: 'grants',
              fields: [
                { name: 'role', type: 'text' },
                { name: 'perm', type: 'text' },
                { name: 'allowed', type: 'boolean' },
              ],
            },
            {
              name: 'places',
              fields: [
                { name: 'name', type: 'text' },
                { name: 'at', type: 'location' },
              ],
            },
          ],
        };
      }
      if (url === '/api/actions')
        return { actions: [{ extension: 'tasks', name: 'move', input: {} }] };
      throw new Error(`unexpected ${url}`);
    },
    post: (url: string, body: unknown) => post(url, body),
  },
  dataApi: {
    list: async (collection: string, params: Record<string, unknown>) => {
      calls.push(`LIST ${collection} ${JSON.stringify(params)}`);
      const records = tables[collection] ?? [];
      return { records, pagination: { total: records.length } };
    },
    update: (c: string, id: string, d: unknown) => update(c, id, d),
    create: (c: string, d: unknown) => create(c, d),
  },
}));

const leaflet = vi.hoisted(() => {
  const tooltips: unknown[] = [];
  const layer = () => {
    const l: Record<string, unknown> = {};
    l.addTo = () => l;
    l.bindTooltip = (tip: unknown) => {
      tooltips.push(tip);
      return l;
    };
    l.on = () => l;
    return l;
  };
  const map = {
    getContainer: () => null as unknown,
    eachLayer: () => {},
    fitBounds: vi.fn(),
    setView: vi.fn(),
    remove: () => {},
  };
  return {
    map,
    tooltips,
    circleMarker: vi.fn(() => layer()),
    L: {
      map: (node: unknown) => {
        map.getContainer = () => node;
        return map;
      },
      tileLayer: () => layer(),
      circleMarker: (...a: unknown[]) => leaflet.circleMarker(...(a as [])),
      latLngBounds: (p: unknown) => p,
    },
  };
});
vi.mock('leaflet', () => ({ default: leaflet.L }));

beforeEach(() => {
  calls.length = 0;
  update.mockClear();
  create.mockClear();
  post.mockClear();
  leaflet.circleMarker.mockClear();
});
afterEach(cleanup);

async function draw(view: Record<string, unknown>) {
  const { default: ViewPage } = await import('./ViewPage.svelte');
  return render(ViewPage, { props: { ext: 'tasks', view: view as never } });
}

describe('view/2 board', () => {
  it('draws a column per declared choice, then the values found, and moves a card through the data API', async () => {
    const { container, getAllByLabelText } = await draw({
      type: 'board',
      collection: 'tasks',
      groupBy: 'status',
      card: ['title'],
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    expect(container.querySelector('[data-testid="view-not-drawn"]')).toBeNull();
    const cols = [...container.querySelectorAll('[data-column]')].map((c) =>
      c.getAttribute('data-column'),
    );
    expect(cols).toEqual(['todo', 'doing', 'done', 'archived']);
    expect(container.querySelector('[data-column="done"] h3')?.textContent).toContain('Done!');
    expect(container.querySelector('[data-column="doing"]')?.textContent).toContain('Review');

    // Keyboard path: the card's "Move to" menu.
    await fireEvent.change(getAllByLabelText('Move to')[0], { target: { value: 'done' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't1', { status: 'done' }));

    // Pointer path: drag a card onto another column.
    const card = container.querySelector('[data-column="doing"] li') as HTMLElement;
    await fireEvent.dragStart(card);
    await fireEvent.drop(container.querySelector('[data-column="todo"]') as HTMLElement);
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't2', { status: 'todo' }));
  }, 60_000);

  it('a move named as an action runs it, `$record` being the record after the move', async () => {
    const { container, getAllByLabelText } = await draw({
      type: 'board',
      collection: 'tasks',
      groupBy: 'status',
      move: { action: 'move', input: { id: { $record: 'id' }, to: { $record: 'status' } } },
    });
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    await fireEvent.change(getAllByLabelText('Move to')[0], { target: { value: 'doing' } });
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/ext/tasks/actions/move', { id: 't1', to: 'doing' }),
    );
    expect(update).not.toHaveBeenCalled();
  }, 60_000);

  it('without `move` nothing can be moved', async () => {
    const { container, queryAllByLabelText } = await draw({
      type: 'board',
      collection: 'tasks',
      groupBy: 'status',
    });
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    expect(queryAllByLabelText('Move to')).toHaveLength(0);
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  }, 60_000);
});

describe('view/2 timeline', () => {
  it('reads one period through the data API filter and moves a record by whole days', async () => {
    const { container } = await draw({
      type: 'timeline',
      collection: 'tasks',
      start: 'due',
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    const until = shiftDays(month[month.length - 1], 1);
    expect(calls).toContain(
      `LIST tasks ${JSON.stringify({
        page: 1,
        limit: 500,
        filter: JSON.stringify({ due: { lt: until, gte: month[0] } }),
        sort: 'due',
        order: 'asc',
      })}`,
    );
    const cell = container.querySelector(`[data-day="${today}"]`) as HTMLElement;
    expect(cell.textContent).toContain('Write spec');
    // A record with no date is not on the axis.
    expect(container.textContent).not.toContain('Ship');

    await fireEvent.dragStart(cell.querySelector('[data-record="t1"]') as HTMLElement);
    await fireEvent.drop(container.querySelector(`[data-day="${other}"]`) as HTMLElement);
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't1', { due: other }));
  }, 60_000);

  it('a gantt draws a lane per record over the month', async () => {
    const { container } = await draw({
      type: 'timeline',
      collection: 'tasks',
      start: 'due',
      end: 'due',
      scale: 'gantt',
    });
    await waitFor(() => expect(container.textContent).toContain('Review'));
    expect(container.querySelectorAll('[data-record]')).toHaveLength(2);
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  }, 60_000);
});

describe('view/2 tree', () => {
  it('nests records under their parent; a node never moves into its own descendant', async () => {
    const { container } = await draw({
      type: 'tree',
      collection: 'tasks',
      parent: 'parent_id',
      label: 'title',
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Ship'));
    const node = (id: string) => container.querySelector(`[data-node="${id}"]`) as HTMLElement;
    // t3 sits two levels under t1.
    expect(node('t1').closest('li')?.querySelector('[data-node="t3"]')).toBeTruthy();

    await fireEvent.dragStart(node('t1'));
    await fireEvent.drop(node('t3'));
    expect(update).not.toHaveBeenCalled();

    await fireEvent.dragStart(node('t3'));
    await fireEvent.drop(node('root'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't3', { parent_id: null }));
  }, 60_000);
});

describe('view/2 matrix', () => {
  it('draws the relation as a grid; an edit updates a record or creates an empty cell', async () => {
    const { container } = await draw({
      type: 'matrix',
      collection: 'grants',
      row: 'role',
      column: 'perm',
      value: 'allowed',
      edit: 'patch',
    });
    const box = (cell: string) =>
      container.querySelector(`[data-cell="${cell}"] input`) as HTMLInputElement;
    await waitFor(() => expect(box('admin/read')).toBeTruthy());
    expect(box('admin/read').checked).toBe(true);
    expect(box('editor/write').checked).toBe(false);

    await fireEvent.click(box('admin/read'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('grants', 'g1', { allowed: false }));
    await fireEvent.click(box('editor/read'));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith('grants', {
        role: 'editor',
        perm: 'read',
        allowed: true,
      }),
    );
  }, 60_000);
});

describe('view/2 map', () => {
  it('places the records that have a location, on the map and in the list', async () => {
    const { container } = await draw({ type: 'map', collection: 'places', location: 'at' });
    await waitFor(() => expect(container.textContent).toContain('Office'));
    expect(container.textContent).toContain('44.43000, 26.10000');
    expect(container.textContent).not.toContain('Nowhere');
    // Redrawn as the records and the schema arrive; only the placed record, every time.
    await waitFor(() => expect(leaflet.circleMarker).toHaveBeenCalled());
    for (const call of leaflet.circleMarker.mock.calls as unknown[][])
      expect(call).toEqual([[44.43, 26.1], { radius: 7 }]);
    // Leaflet reads a string tooltip as HTML: the label must be a text node.
    expect(leaflet.tooltips.length).toBeGreaterThan(0);
    for (const tip of leaflet.tooltips) expect(tip).toBeInstanceOf(HTMLElement);
  }, 60_000);
});

describe('view/2 fallback', () => {
  it('a kind Studio does not know draws its own fallback, else the generated list', async () => {
    const own = await draw({
      type: 'gallery',
      collection: 'tasks',
      fallback: { type: 'board', collection: 'tasks', groupBy: 'status' },
    });
    await waitFor(() => expect(own.container.textContent).toContain('Write spec'));
    expect(own.container.querySelector('[data-testid="view-board"]')).toBeTruthy();
    expect(own.container.querySelector('[data-testid="view-not-drawn"]')).toBeTruthy();
    cleanup();

    const generated = await draw({ type: 'gallery', collection: 'tasks' });
    await waitFor(() => expect(generated.container.textContent).toContain('Write spec'));
    expect(generated.container.querySelector('[data-testid="view-list"]')).toBeTruthy();
  }, 60_000);
});
