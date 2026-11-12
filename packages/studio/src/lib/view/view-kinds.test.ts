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
  // A timeline with an `end`: one span into the month, one with no end at all.
  events: [
    { id: 'e1', title: 'Conference', starts: shiftDays(month[0], -3), ends: today },
    { id: 'e2', title: 'Open-ended', starts: today, ends: null },
    {
      id: 'e3',
      title: 'Long gone',
      starts: shiftDays(month[0], -40),
      ends: shiftDays(month[0], -30),
    },
  ],
  // A matrix whose rows are a relation: `r9` is a role the caller cannot read.
  checks: [
    { id: 'c1', role: 'r1', perm: 'read', done: true },
    { id: 'c2', role: 'r9', perm: 'read', done: false },
  ],
  roles: [{ id: 'r1', name: 'Administrator' }],
  // A tree with an order: two roots, and two children with the same position.
  outline: [
    { id: 'o1', title: 'One', parent: null, pos: 1 },
    { id: 'o2', title: 'Two', parent: null, pos: 2 },
    { id: 'o3', title: 'Child A', parent: 'o1', pos: 5 },
    { id: 'o4', title: 'Child B', parent: 'o1', pos: 5 },
  ],
  // A cycle in the data: x under y under x, and nothing else.
  loop: [
    { id: 'x', title: 'Ex', parent: 'y' },
    { id: 'y', title: 'Why', parent: 'x' },
  ],
  // More records than one page of the data API (500).
  bulk: Array.from({ length: 501 }, (_, i) => ({
    id: `b${i}`,
    title: `Item ${i}`,
    status: i === 0 ? 'doing' : 'todo',
    due: today,
    parent: null,
    role: `r${i % 2}`,
    perm: `p${i % 3}`,
    on: true,
    at: { lat: 1, lng: i / 10 },
  })),
};

/** What the data API answers to `filter` (eq, in, null, lt, gte), `sort`, `page` and `limit`. */
function answer(collection: string, params: Record<string, unknown>) {
  let records = [...(tables[collection] ?? [])];
  const filter = JSON.parse(String(params.filter ?? '{}')) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [field, ops] of Object.entries(filter)) {
    for (const [op, want] of Object.entries(ops)) {
      records = records.filter((r) => {
        const v = r[field];
        if (op === 'null') return v == null;
        if (op === 'in') return (want as unknown[]).includes(v);
        if (op === 'eq') return v === want;
        if (v == null) return false;
        return op === 'lt' ? String(v) < String(want) : String(v) >= String(want);
      });
    }
  }
  if (params.sort) {
    const k = String(params.sort);
    records.sort((a, b) => Number(a[k]) - Number(b[k]));
  }
  const limit = Number(params.limit ?? 25);
  const page = Number(params.page ?? 1);
  return {
    records: records.slice((page - 1) * limit, page * limit),
    pagination: { total: records.length },
  };
}
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
            {
              name: 'events',
              fields: [
                { name: 'title', type: 'text' },
                { name: 'starts', type: 'date' },
                { name: 'ends', type: 'date' },
              ],
            },
            {
              name: 'checks',
              fields: [
                { name: 'role', type: 'reference', options: { related_collection: 'roles' } },
                { name: 'perm', type: 'text' },
                { name: 'done', type: 'boolean' },
              ],
            },
            { name: 'roles', fields: [{ name: 'name', type: 'text' }] },
            {
              name: 'outline',
              fields: [
                { name: 'title', type: 'text' },
                { name: 'parent', type: 'reference' },
                { name: 'pos', type: 'integer' },
              ],
            },
            {
              name: 'loop',
              fields: [
                { name: 'title', type: 'text' },
                { name: 'parent', type: 'reference' },
              ],
            },
            {
              name: 'bulk',
              fields: [
                { name: 'title', type: 'text' },
                { name: 'status', type: 'text' },
                { name: 'due', type: 'date' },
                { name: 'parent', type: 'reference' },
                { name: 'role', type: 'text' },
                { name: 'perm', type: 'text' },
                { name: 'on', type: 'boolean' },
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
      return answer(collection, params);
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

describe('view/2 kinds: more than one page', () => {
  const kinds: [string, Record<string, unknown>][] = [
    ['board', { type: 'board', collection: 'bulk', groupBy: 'status' }],
    ['timeline', { type: 'timeline', collection: 'bulk', start: 'due', scale: 'day' }],
    ['tree', { type: 'tree', collection: 'bulk', parent: 'parent', label: 'title' }],
    ['matrix', { type: 'matrix', collection: 'bulk', row: 'role', column: 'perm', value: 'on' }],
    ['map', { type: 'map', collection: 'bulk', location: 'at', label: 'title' }],
  ];
  it.each(kinds)(
    '%s reads the next page only when asked, and appends it',
    async (_kind, view) => {
      const { getByText, container } = await draw(view);
      await waitFor(() => expect(getByText('Load more')).toBeTruthy());
      expect(container.textContent).toContain('Showing the first 500 of 501 records.');
      const pages = () =>
        calls.filter((c) => c.startsWith('LIST bulk ')).map((c) => JSON.parse(c.slice(10)).page);
      expect(pages()).toEqual([1]);
      await fireEvent.click(getByText('Load more'));
      await waitFor(() => expect(container.textContent).not.toContain('Load more'));
      expect(pages()).toEqual([1, 2]);
      expect(container.querySelector('[data-testid="view-truncated"]')).toBeNull();
    },
    60_000,
  );

  it('a re-read after a write keeps the pages already read', async () => {
    const { getByText, getAllByLabelText } = await draw({
      type: 'board',
      collection: 'bulk',
      groupBy: 'status',
      move: 'patch',
    });
    await waitFor(() => expect(getByText('Load more')).toBeTruthy());
    await fireEvent.click(getByText('Load more'));
    await waitFor(() => expect(getAllByLabelText('Move to')).toHaveLength(501));
    calls.length = 0;
    await fireEvent.change(getAllByLabelText('Move to')[0], { target: { value: 'todo' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('bulk', 'b0', { status: 'todo' }));
    await waitFor(() => expect(calls.filter((c) => c.startsWith('LIST bulk '))).toHaveLength(2));
    expect(getAllByLabelText('Move to')).toHaveLength(501);
  }, 60_000);
});

describe('view/2 timeline with an end', () => {
  it('shows what overlaps the period and what has no end, asked apart and merged', async () => {
    const { container } = await draw({
      type: 'timeline',
      collection: 'events',
      start: 'starts',
      end: 'ends',
      scale: 'gantt',
    });
    await waitFor(() => expect(container.textContent).toContain('Open-ended'));
    expect(container.textContent).toContain('Conference');
    expect(container.textContent).not.toContain('Long gone');
    const filters = calls
      .filter((c) => c.startsWith('LIST events '))
      .map((c) => JSON.parse(JSON.parse(c.slice(12)).filter));
    expect(filters).toContainEqual({
      starts: { lt: shiftDays(month[month.length - 1], 1) },
      ends: { gte: month[0] },
    });
    expect(filters).toContainEqual({
      starts: { lt: shiftDays(month[month.length - 1], 1), gte: month[0] },
      ends: { null: true },
    });
  }, 60_000);

  it('a record is moved from the keyboard: its menu takes a day', async () => {
    const { container, getAllByLabelText } = await draw({
      type: 'timeline',
      collection: 'tasks',
      start: 'due',
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Write spec'));
    const input = container
      .querySelector('[data-record="t1"]')
      ?.closest('details')
      ?.querySelector('input');
    expect(getAllByLabelText('Move to')).toContain(input);
    await fireEvent.change(input as HTMLInputElement, { target: { value: other } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't1', { due: other }));
  }, 60_000);
});

describe('view/2 matrix on a relation', () => {
  it("shows the related record's label, read by id; one the caller cannot read stays its id", async () => {
    const { container } = await draw({
      type: 'matrix',
      collection: 'checks',
      row: 'role',
      column: 'perm',
      value: 'done',
    });
    await waitFor(() => expect(container.textContent).toContain('Administrator'));
    const heads = [...container.querySelectorAll('tbody th')].map((th) => th.textContent?.trim());
    expect(heads).toEqual(['Administrator', 'r9']);
    expect(calls).toContain(
      `LIST roles ${JSON.stringify({ page: 1, limit: 2, filter: JSON.stringify({ id: { in: ['r1', 'r9'] } }) })}`,
    );
    // Asked once: the missing one is not asked again.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.startsWith('LIST roles '))).toHaveLength(1);
  }, 60_000);
});

describe('view/2 tree, from the keyboard and in order', () => {
  it('"Move to" offers the root and every node but the node and its descendants', async () => {
    const { container } = await draw({
      type: 'tree',
      collection: 'tasks',
      parent: 'parent_id',
      label: 'title',
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Ship'));
    const open = (id: string) =>
      container
        .querySelector(`[data-node="${id}"]`)
        ?.querySelector('[aria-expanded]:last-child') as HTMLElement;
    const options = (id: string) =>
      [...(container.querySelector(`[data-move="${id}"]`)?.querySelectorAll('option') ?? [])].map(
        (o) => o.textContent,
      );
    await fireEvent.click(open('t1'));
    expect(options('t1')).toEqual(['(none)']);
    await fireEvent.click(open('t3'));
    expect(options('t3')).toEqual(['(none)', 'Write spec', 'Review']);
    await fireEvent.change(container.querySelector('[data-move="t3"]') as HTMLSelectElement, {
      target: { value: 't1' },
    });
    await waitFor(() => expect(update).toHaveBeenCalledWith('tasks', 't3', { parent_id: 't1' }));
  }, 60_000);

  it('"Move up" and "Move down" swap `order` with the sibling; equal ones take their positions', async () => {
    const { container, getAllByLabelText } = await draw({
      type: 'tree',
      collection: 'outline',
      parent: 'parent',
      label: 'title',
      order: 'pos',
      move: 'patch',
    });
    await waitFor(() => expect(container.textContent).toContain('Child B'));
    const button = (id: string, label: string) =>
      container.querySelector(`[data-node="${id}"] [aria-label="${label}"]`) as HTMLElement;
    expect(getAllByLabelText('Move up')).toHaveLength(4);

    // Different positions: each takes the other's.
    await fireEvent.click(button('o1', 'Move down'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls).toEqual([
      ['outline', 'o1', { pos: 2 }],
      ['outline', 'o2', { pos: 1 }],
    ]);

    // The same position (5 and 5): they take their places among the siblings, 0 and 1.
    update.mockClear();
    await fireEvent.click(button('o4', 'Move up'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls).toEqual([
      ['outline', 'o4', { pos: 0 }],
      ['outline', 'o3', { pos: 1 }],
    ]);

    // The first sibling has nothing above it.
    update.mockClear();
    await fireEvent.click(button('o3', 'Move up'));
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();

    // A refused first write leaves the sibling alone.
    update.mockRejectedValueOnce(new Error('denied'));
    await fireEvent.click(button('o2', 'Move up'));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(update).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a cycle in the data is drawn once, broken at its first record', async () => {
    const { container } = await draw({
      type: 'tree',
      collection: 'loop',
      parent: 'parent',
      label: 'title',
    });
    await waitFor(() => expect(container.textContent).toContain('Ex'));
    expect(container.querySelectorAll('[data-node="x"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-node="y"]')).toHaveLength(1);
    // x is the root, y under it.
    expect(
      container.querySelector('[data-node="x"]')?.closest('li')?.querySelector('[data-node="y"]'),
    ).toBeTruthy();
  }, 60_000);
});
