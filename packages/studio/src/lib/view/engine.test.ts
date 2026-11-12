import { describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api.js', () => ({ api: {}, dataApi: {} }));

import {
  actionInputFields,
  elapsed,
  findAction,
  formPayload,
  listParams,
  toFormField,
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
