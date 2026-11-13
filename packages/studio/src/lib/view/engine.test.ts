import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api.js', () => ({ api: {}, dataApi: {} }));

import {
  actionInputFields,
  actionInputLines,
  actionInputUndrawn,
  choicesOf,
  dayKey,
  daysBetween,
  elapsed,
  findAction,
  formPayload,
  isWithin,
  listParams,
  period,
  periodQueries,
  relatedOf,
  shiftDays,
  reorder,
  toFormField,
  treeParents,
  viewHref,
} from './engine.js';

describe('listParams', () => {
  it('sends the filter as the data API JSON filter, sort and search', () => {
    expect(
      listParams(
        { filter: [{ field: 'owner', op: 'eq', value: { $user: 'id' } }], sort: '-created_at' },
        { user: 'u1', params: {}, selected: {} },
        { page: 2, limit: 10, search: ' acme ' },
      ),
    ).toEqual({
      page: 2,
      limit: 10,
      filter: '{"owner":{"eq":"u1"}}',
      sort: 'created_at',
      order: 'desc',
      search: 'acme',
    });
  });

  it('waits while a pane it filters on has no selection', () => {
    expect(
      listParams(
        { filter: [{ field: 'folder_id', op: 'eq', value: { $selected: 'folders' } }] },
        { selected: {} },
        { page: 1, limit: 25 },
      ),
    ).toBeNull();
  });
});

describe('fields', () => {
  it('maps a collection field to the input SchemaForm draws', () => {
    expect(toFormField({ name: 'amount_due', type: 'decimal', required: true })).toEqual({
      name: 'amount_due',
      fieldType: 'decimal',
      type: 'number',
      label: 'Amount Due',
      required: true,
    });
    expect(
      toFormField({
        name: 's',
        type: 'select',
        options: { choices: ['a', { value: 'b', label: 'B' }] },
      }),
    ).toMatchObject({ type: 'select', options: ['a', { value: 'b', label: 'B' }] });
    // A select without choices is a text input, not an empty dropdown.
    expect(toFormField({ name: 's', type: 'select' }).type).toBe('text');
    // Untrusted rich text is edited as text, never rendered.
    expect(toFormField({ name: 'body', type: 'richtext' }).type).toBe('textarea');
  });

  it('reads an action input JSON Schema', () => {
    expect(
      actionInputFields({
        properties: {
          reason: { type: 'string', title: 'Why' },
          days: { type: ['integer', 'null'] },
          kind: { enum: ['a', 'b'] },
        },
        required: ['reason'],
      }),
    ).toEqual([
      { name: 'reason', type: 'text', required: true, label: 'Why' },
      { name: 'days', type: 'number', required: false },
      { name: 'kind', type: 'select', required: false, options: { choices: ['a', 'b'] } },
    ]);
  });

  it('reads a list of objects in an action input as lines, never as a text input', () => {
    const input = {
      properties: {
        client: { type: 'string' },
        meta: { type: 'object' },
        tags: { type: 'array', items: { type: 'string' } },
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['description'],
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              metadata: { type: 'object' },
            },
          },
        },
      },
    };
    expect(actionInputFields(input).map((f) => f.name)).toEqual(['client']);
    expect(actionInputLines(input)).toEqual([
      {
        name: 'lines',
        min: 1,
        columns: [
          { name: 'description', type: 'text', required: true },
          { name: 'quantity', type: 'number', required: false },
        ],
        integers: [],
      },
    ]);
    expect(actionInputUndrawn({ ...input, required: ['meta', 'lines', 'client'] })).toEqual([
      'meta',
    ]);
  });

  it('turns form values into a body: numbers, and empty inputs by mode', () => {
    const fields = [
      { name: 'n', type: 'number' },
      { name: 't', type: 'text' },
    ];
    expect(formPayload({ n: '4.5', t: '' }, fields)).toEqual({ n: 4.5 });
    expect(formPayload({ n: '4.5', t: '' }, fields, true)).toEqual({ n: 4.5, t: null });
  });

  it('a json field goes back as the value its text spells, or fails the save', () => {
    const f = [toFormField({ name: 'meta', type: 'json' })];
    expect(f[0].type).toBe('textarea');
    expect(formPayload({ meta: '{"a":[1,2]}' }, f)).toEqual({ meta: { a: [1, 2] } });
    // Unedited, the loaded object goes back as it came.
    expect(formPayload({ meta: { a: 1 } }, f)).toEqual({ meta: { a: 1 } });
    expect(() => formPayload({ meta: '{nope' }, f)).toThrow('not valid JSON');
  });
});

describe('navigation', () => {
  const pages = [
    { path: '/admin/billing', schema: { spec: 'zveltio.view/2', id: 'billing.invoices' } },
    { path: '/admin/billing/invoices/:id', schema: { id: 'billing.invoice' } },
  ];
  it('finds the page of a view and fills its path', () => {
    expect(viewHref(pages, 'billing.invoice', { id: 'i 1', tab: 'lines' })).toBe(
      '/billing/invoices/i%201?tab=lines',
    );
    expect(viewHref(pages, 'billing.invoices', {})).toBe('/billing');
    expect(viewHref(pages, 'billing.nope', {})).toBeNull();
  });

  it('finds a dependency action by `<dependency>.<action>`', () => {
    const list = [
      { extension: 'billing', name: 'pay', input: {} },
      { extension: 'mail', name: 'send', input: {} },
    ];
    expect(findAction(list, 'billing', 'pay')?.extension).toBe('billing');
    expect(findAction(list, 'billing', 'mail.send')?.extension).toBe('mail');
    expect(findAction(list, 'billing', 'refund')).toBeUndefined();
  });
});

describe('elapsed', () => {
  it('says how long ago', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(elapsed('2026-11-12T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(elapsed('not a date', now, 'en')).toBe('not a date');
  });
});

describe('the slice 4 kinds: time, trees, choices', () => {
  it('a period is a day, a week from Monday, or a whole month', () => {
    expect(period('2026-11-12', 'day')).toEqual(['2026-11-12']);
    expect(period('2026-11-12', 'week')).toEqual([
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
    ]);
    const feb = period('2028-02-20', 'gantt');
    expect([feb[0], feb.length, feb[feb.length - 1]]).toEqual(['2028-02-01', 29, '2028-02-29']);
  });

  it('a move keeps a date a date and a timestamp its time of day', () => {
    expect(shiftDays('2026-11-30', 2)).toBe('2026-12-02');
    const at = new Date(2026, 10, 12, 9, 30).toISOString();
    const moved = new Date(shiftDays(at, -3) as string);
    expect([moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([9, 9, 30]);
    expect(shiftDays(null, 1)).toBeNull();
    expect(daysBetween('2026-11-30', '2026-12-02')).toBe(2);
    // A date is its own day, never shifted by the time zone.
    expect(dayKey('2026-11-12')).toBe('2026-11-12');
    expect(dayKey(new Date(2026, 10, 12, 23, 59).toISOString())).toBe('2026-11-12');
    expect(dayKey('soon')).toBeNull();
  });

  it('a node is within itself and its ancestors chain, and a cycle in the data ends the walk', () => {
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
      ['x', 'y'],
      ['y', 'x'],
    ]);
    expect(isWithin('a', 'c', parentOf)).toBe(true);
    expect(isWithin('c', 'c', parentOf)).toBe(true);
    expect(isWithin('c', 'a', parentOf)).toBe(false);
    expect(isWithin('a', 'x', parentOf)).toBe(false);
  });

  it('choices come as declared: plain values or { value, label }', () => {
    expect(
      choicesOf({
        name: 's',
        type: 'select',
        options: { choices: ['a', { value: 2, label: 'Two' }] },
      }),
    ).toEqual([
      { value: 'a', label: 'a' },
      { value: '2', label: 'Two' },
    ]);
    expect(choicesOf({ name: 't', type: 'text' })).toEqual([]);
  });
});

describe('the slice 4 kinds: queries, order, cycles, relations', () => {
  it('a timeline with an end asks twice: what overlaps, and what has no end', () => {
    const own = [{ field: 'kind', op: 'eq' as const, value: 'trip' }];
    expect(periodQueries(own, 's', undefined, '2026-11-01', '2026-12-01')).toEqual([
      [
        ...own,
        { field: 's', op: 'lt', value: '2026-12-01' },
        { field: 's', op: 'gte', value: '2026-11-01' },
      ],
    ]);
    expect(periodQueries(own, 's', 'e', '2026-11-01', '2026-12-01')).toEqual([
      [
        ...own,
        { field: 's', op: 'lt', value: '2026-12-01' },
        { field: 'e', op: 'gte', value: '2026-11-01' },
      ],
      [
        ...own,
        { field: 's', op: 'lt', value: '2026-12-01' },
        { field: 's', op: 'gte', value: '2026-11-01' },
        { field: 'e', op: 'null' },
      ],
    ]);
    // The view's own `s gte` stays the view's.
    const mine = [{ field: 's', op: 'gte' as const, value: { $today: true as const } }];
    expect(periodQueries(mine, 's', undefined, 'a', 'b')).toEqual([
      [...mine, { field: 's', op: 'lt', value: 'b' }],
    ]);
  });

  it('swapping order: each takes the other; equal or empty, all siblings are renumbered', () => {
    const sibs = [
      { id: 'a', pos: 3 },
      { id: 'b', pos: 7 },
      { id: 'c', pos: 7 },
    ];
    expect(reorder(sibs, 0, 1, 'pos')).toEqual({
      renumber: false,
      writes: [
        { record: sibs[0], patch: { pos: 7 } },
        { record: sibs[1], patch: { pos: 3 } },
      ],
    });
    // Equal (or empty): every sibling renumbered 0..n-1 in the new order.
    expect(reorder(sibs, 2, 1, 'pos')).toEqual({
      renumber: true,
      writes: [
        { record: sibs[0], patch: { pos: 0 } },
        { record: sibs[2], patch: { pos: 1 } },
        { record: sibs[1], patch: { pos: 2 } },
      ],
    });
    expect(reorder([{ pos: null }, { pos: 4 }], 0, 1, 'pos').renumber).toBe(true);
  });

  it('a parent outside the rows is none, and a cycle is broken at its first record', () => {
    const rows = [
      { id: 'a', p: 'gone' },
      { id: 'x', p: 'y' },
      { id: 'y', p: 'x' },
      { id: 'z', p: 'y' },
    ];
    expect(Object.fromEntries(treeParents(rows, 'p'))).toEqual({
      a: null,
      x: null,
      y: 'x',
      z: 'y',
    });
  });

  it('a relation names its collection; any other field none', () => {
    expect(relatedOf({ name: 'r', type: 'm2o', options: { related_collection: 'roles' } })).toBe(
      'roles',
    );
    expect(
      relatedOf({ name: 'r', type: 'text', options: { related_collection: 'roles' } }),
    ).toBeNull();
    expect(relatedOf({ name: 'r', type: 'reference' })).toBeNull();
  });
});
