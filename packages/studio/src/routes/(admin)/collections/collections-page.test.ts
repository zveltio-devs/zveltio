import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Select all" over a filtered list must select what the list shows.
 *
 * The grid renders `filtered`; the select-all handler iterated the unfiltered
 * collection list. With a search active, one click selected every collection in
 * the instance — including the ones not on screen — and the bulk action next to
 * it is an irreversible drop of the table and its data.
 */
const del = vi.fn(async (_name: string) => ({}));
vi.mock('$lib/api.js', () => ({
  collectionsApi: {
    list: vi.fn(async () => ({
      collections: [
        { name: 'invoices', display_name: 'Invoices', fields: [] },
        { name: 'orders', display_name: 'Orders', fields: [] },
        { name: 'products', display_name: 'Products', fields: [] },
        { name: 'customers', display_name: 'Customers', fields: [] },
        { name: 'shipments', display_name: 'Shipments', fields: [] },
        { name: 'payments', display_name: 'Payments', fields: [] },
      ],
    })),
    fieldTypes: vi.fn(async () => ({ field_types: [] })),
    create: vi.fn(),
    delete: (name: string) => del(name),
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/collections') } }));

import Page from './+page.svelte';

beforeEach(() => del.mockClear());
afterEach(cleanup);

describe('collections list — bulk selection', () => {
  it('select-all covers only the collections the search leaves visible', async () => {
    const { getByPlaceholderText, getByLabelText } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Invoices'));

    const search = getByPlaceholderText(/search/i) as HTMLInputElement;
    search.value = 'invoices';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).not.toContain('Orders'));

    (getByLabelText(/select all/i) as HTMLInputElement).click();
    await waitFor(() => expect(document.querySelector('[role="region"] strong')).not.toBeNull());
    expect(document.querySelector('[role="region"] strong')?.textContent).toBe('1');
  });

  it('matches a search term with a trailing space', async () => {
    const { getByPlaceholderText } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Invoices'));

    const search = getByPlaceholderText(/search/i) as HTMLInputElement;
    search.value = 'invoices ';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => expect(document.body.textContent).not.toContain('Orders'));

    expect(document.body.textContent).toContain('Invoices');
  });
});
