import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A selection is made from the rows on screen. When the resource, the page or a
 * filter changes those rows are replaced, so the ids must not survive: a bulk
 * action taken afterwards posted the previous tab's ids to this resource's
 * endpoint.
 */
const rowsByTab: Record<string, { id: string; name: string }[]> = {
  invoices: [{ id: 'inv-1', name: 'Invoice 1' }],
  payments: [{ id: 'pay-1', name: 'Payment 1' }],
};

const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
const get = vi.fn(async (url: string) =>
  url.includes('payments') ? rowsByTab.payments : rowsByTab.invoices,
);
vi.mock('$lib/api.js', () => ({
  api: {
    get: (url: string) => get(url),
    post: vi.fn(),
    patch: (url: string, body: unknown) => patch(url, body),
    put: vi.fn(),
    delete: vi.fn(),
    fetch: vi.fn(),
  },
}));

const schema = {
  title: 'Billing',
  resources: ['invoices', 'payments'].map((id) => ({
    id,
    label: id,
    dataSource: `/ext/billing/${id}`,
    selectable: true,
    bulkActions: [{ id: 'archive', label: 'archive', endpoint: `/ext/billing/${id}/archive` }],
    columns: [{ key: 'name', label: 'name', editable: { endpoint: `/ext/billing/${id}/{id}` } }],
  })),
};

afterEach(cleanup);

describe('SchemaPage inline edit', () => {
  it('saves on change, not on a blur that changed nothing', async () => {
    const { default: SchemaPage } = await import('./SchemaPage.svelte');
    const { container } = render(SchemaPage, { props: { schema, extName: 'billing' } });

    const cell = () => container.querySelector<HTMLInputElement>('tbody input.input-xs');
    await waitFor(() => expect(cell()).toBeTruthy());

    // Tabbing through the table must not PATCH every cell it passes.
    await fireEvent.blur(cell()!);
    expect(patch).not.toHaveBeenCalled();

    await fireEvent.input(cell()!, { target: { value: 'Invoice 2' } });
    await fireEvent.change(cell()!);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  }, 60_000);
});

describe('SchemaPage selection', () => {
  it('drops the selection when the active resource changes', async () => {
    const { default: SchemaPage } = await import('./SchemaPage.svelte');
    const { container, getByText } = render(SchemaPage, {
      props: { schema, extName: 'billing' },
    });

    const rowBox = () =>
      container.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')[0];
    await waitFor(() => expect(rowBox()).toBeTruthy());
    await fireEvent.click(rowBox());
    await waitFor(() => expect(container.textContent).toContain('1 selected'));

    await fireEvent.click(getByText('payments'));

    await waitFor(() => expect(container.textContent).not.toContain('1 selected'));
  }, 60_000);
});

/**
 * The edit form is filled from the LIST row. A field the list does not carry
 * (an edge function's `env_vars`, kept out of the list because it holds
 * secrets) got the blank default, and the PATCH sent it: editing the function
 * from this page replaced its env vars with `{}`. A json field the row does
 * carry arrived as an object, which the textarea showed as `[object Object]`
 * and the payload could not parse back.
 */
describe('SchemaPage edit form', () => {
  it('does not send a field the row did not carry; round-trips a json value it did', async () => {
    patch.mockClear();
    get.mockImplementation(async () => [{ id: 'fn-1', name: 'probe', tags: ['a', 'b'] }]);
    const editSchema = {
      title: 'Functions',
      resources: [
        {
          id: 'functions',
          label: 'functions',
          dataSource: '/ext/fns',
          columns: [{ key: 'name', label: 'name' }],
          rowActions: [{ id: 'edit', kind: 'edit' as const, label: 'edit' }],
          form: {
            endpoint: '/ext/fns',
            fields: [
              { name: 'name', label: 'name' },
              { name: 'tags', label: 'tags', type: 'json' as const },
              { name: 'env_vars', label: 'env', type: 'json' as const, default: '{}' },
            ],
          },
        },
      ],
    };
    const { default: SchemaPage } = await import('./SchemaPage.svelte');
    const { container } = render(SchemaPage, { props: { schema: editSchema, extName: 'fns' } });
    const edit = () => container.querySelector<HTMLButtonElement>('button[title="edit"]');
    await waitFor(() => expect(edit()).toBeTruthy());
    await fireEvent.click(edit()!);
    const form = await waitFor(() => {
      const f = document.querySelector('form');
      expect(f).toBeTruthy();
      return f!;
    });
    await fireEvent.submit(form);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [url, body] = patch.mock.calls[0]!;
    expect(url).toBe('/ext/fns/fn-1');
    expect(body).toEqual({ name: 'probe', tags: ['a', 'b'] });

    // Changed, it is sent.
    await fireEvent.click(edit()!);
    const env = await waitFor(() => {
      const t = document.querySelectorAll<HTMLTextAreaElement>('form textarea')[1];
      expect(t).toBeTruthy();
      return t!;
    });
    await fireEvent.input(env, { target: { value: '{"A":"1"}' } });
    await fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[1]![1]).toEqual({
      name: 'probe',
      tags: ['a', 'b'],
      env_vars: { A: '1' },
    });
  }, 60_000);
});
