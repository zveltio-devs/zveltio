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
