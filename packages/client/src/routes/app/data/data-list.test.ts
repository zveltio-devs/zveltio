/**
 * `/app/data/<collection>` on the kit (ADR 0007): the table orders by a column
 * through a link, says which column orders it (`aria-sort`), offers no ordering
 * on a relation, and the loader only forwards a sort on a column the user sees
 * — the engine answers 400 to any other.
 */

import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { toast } from '@zveltio/ui/toast';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));

const { default: Page } = await import('./[collection]/+page.svelte');
const { default: Record } = await import('./[collection]/[id]/+page.svelte');
const { load } = await import('./[collection]/+page.ts');

const collection = {
  name: 'tasks',
  display_name: 'Tasks',
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'tags', label: 'Tags', type: 'm2m' },
  ],
};
const data = (sort: { key: string; dir: 'asc' | 'desc' } | null) => ({
  collection,
  records: [{ id: 'r1', title: 'First', tags: null }],
  pagination: { page: 1, limit: 25, pages: 2 },
  search: '',
  sort,
});

describe('/app/data list on the kit', () => {
  it('orders by a column through a link and marks the column that orders', () => {
    render(Page, { props: { data: data({ key: 'title', dir: 'asc' }) } as never });
    const title = screen.getByRole('columnheader', { name: /Title/ });
    expect(title.getAttribute('aria-sort')).toBe('ascending');
    expect(title.querySelector('a')?.getAttribute('href')).toBe(
      '/app/data/tasks?sort=title&order=desc&page=1',
    );
    const tags = screen.getByRole('columnheader', { name: 'Tags' });
    expect(tags.querySelector('a')).toBeNull();
    expect(tags.hasAttribute('aria-sort')).toBe(false);
    expect(screen.getByLabelText('Next page').getAttribute('href')).toBe(
      '/app/data/tasks?sort=title&order=asc&page=2',
    );
  });

  it('forwards only a sort on a column the user sees', async () => {
    const seen: string[] = [];
    const run = (qs: string) =>
      load({
        params: { collection: 'tasks' },
        url: new URL(`http://x/app/data/tasks?${qs}`),
        parent: async () => ({
          collections: [collection],
          collectionsFailed: false,
          engineUrl: '',
        }),
        fetch: (async (u: string) => {
          seen.push(u);
          return {
            ok: true,
            json: async () => ({ records: [], pagination: { page: 1, limit: 25 } }),
          };
        }) as never,
      } as never) as Promise<{ sort: unknown }>;
    expect((await run('sort=title&order=asc')).sort).toEqual({ key: 'title', dir: 'asc' });
    expect(seen.at(-1)).toContain('sort=title&order=asc');
    expect((await run('sort=password_hash')).sort).toBeNull();
    expect((await run('sort=tags')).sort).toBeNull();
    expect(seen.at(-1)).not.toContain('sort=');
  });
});

describe('/app/data record form on the kit', () => {
  it('ties each input to its label and its description', () => {
    render(Record, {
      props: {
        data: {
          collection: {
            ...collection,
            fields: [
              {
                name: 'title',
                label: 'Title',
                type: 'text',
                description: 'Shown in lists',
                required: true,
              },
            ],
          },
          record: null,
          engineUrl: '',
        },
      } as never,
    });
    const input = screen.getByRole('textbox', { name: 'Title' });
    const hint = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Shown in lists');
    expect(input.getAttribute('aria-required')).toBe('true');
  });
});

describe('kit toasts', () => {
  it('lets an error stay until dismissed and others expire', () => {
    vi.useFakeTimers();
    const info = toast.show('saved', 'success', 1000);
    const err = toast.show('failed', 'error');
    vi.advanceTimersByTime(1500);
    expect(toast.items.map((t) => t.id)).toEqual([err]);
    expect(toast.items.some((t) => t.id === info)).toBe(false);
    toast.dismiss(err);
    expect(toast.items).toEqual([]);
    vi.useRealTimers();
  });
});

describe('/app/data record form words a bad value in the host catalogue', () => {
  it('names the field that is not a number, in the host words', async () => {
    const { fireEvent } = await import('@testing-library/svelte');
    render(Record, {
      props: {
        data: {
          collection: { ...collection, fields: [{ name: 'qty', label: 'Qty', type: 'integer' }] },
          record: null,
          engineUrl: '',
        },
      } as never,
    });
    const input = screen.getByRole('spinbutton', { name: 'Qty' }) as HTMLInputElement;
    // jsdom keeps a typed value on a number input only if it parses; set it raw.
    Object.defineProperty(input, 'value', { configurable: true, get: () => 'four', set: () => {} });
    await fireEvent.input(input);
    await fireEvent.submit(input.closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('qty');
    expect(alert.textContent).not.toContain('not a valid');
  });
});

describe('/app/data filters on the kit', () => {
  const fields = [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'qty', label: 'Qty', type: 'integer' },
    { name: 'tags', label: 'Tags', type: 'm2m' },
  ];

  it('forwards only a filter on a seen field with an operator that field takes', async () => {
    const seen: string[] = [];
    const out = (await load({
      params: { collection: 'tasks' },
      url: new URL(
        'http://x/app/data/tasks?title[contains]=a&qty[gt]=3&qty[contains]=x&tags[eq]=1&secret[eq]=1&title[is_null]=zz',
      ),
      parent: async () => ({
        collections: [{ ...collection, fields }],
        collectionsFailed: false,
        engineUrl: '',
      }),
      fetch: (async (u: string) => {
        seen.push(u);
        return {
          ok: true,
          json: async () => ({ records: [], pagination: { page: 1, limit: 25 } }),
        };
      }) as never,
    } as never)) as { filters: unknown };
    expect(out.filters).toEqual([
      { field: 'title', op: 'contains', value: 'a' },
      { field: 'qty', op: 'gt', value: '3' },
      { field: 'title', op: 'is_null', value: '' },
    ]);
    const qs = new URL(seen[0], 'http://x').searchParams;
    expect(qs.get('title[contains]')).toBe('a');
    expect(qs.get('qty[gt]')).toBe('3');
    expect(qs.has('qty[contains]')).toBe(false);
    expect(qs.has('tags[eq]')).toBe(false);
    expect(qs.has('secret[eq]')).toBe(false);
  });

  it('shows each filter with a link that drops it and keeps the rest', () => {
    render(Page, {
      props: {
        data: {
          ...data({ key: 'title', dir: 'asc' }),
          collection: { ...collection, fields },
          search: 'hi',
          filters: [
            { field: 'title', op: 'contains', value: 'a' },
            { field: 'qty', op: 'gt', value: '3' },
          ],
        },
      } as never,
    });
    const drop = screen.getByLabelText('Remove filter: Title contains a');
    const href = new URL(drop.getAttribute('href')!, 'http://x');
    expect(href.pathname).toBe('/app/data/tasks');
    expect(href.searchParams.get('q')).toBe('hi');
    expect(href.searchParams.get('sort')).toBe('title');
    expect(href.searchParams.get('qty[gt]')).toBe('3');
    expect(href.searchParams.has('title[contains]')).toBe(false);
    expect(href.searchParams.has('page')).toBe(false);
    // Paging and ordering keep the filters.
    expect(screen.getByLabelText('Next page').getAttribute('href')).toContain('qty%5Bgt%5D=3');
    // A relation is not offered.
    const field = screen.getByRole('combobox', { name: 'Field' });
    expect([...field.querySelectorAll('option')].map((o) => o.value)).toEqual(['title', 'qty']);
    expect(screen.getByRole('textbox', { name: 'Value' }).getAttribute('name')).toBe(
      'title[contains]',
    );
  });
});
