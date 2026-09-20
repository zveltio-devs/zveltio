import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One instance of the table serves every collection: the route parameter
 * changes, the component does not remount. The view — search text, sort column,
 * page number, selection — describes the collection that was on screen, and a
 * sort column of the previous collection does not exist in the next one.
 */
const list = vi.fn(async (_c: string, _p?: Record<string, string>) => ({
  records: [{ id: 'r1', title: 'One' }],
  pagination: { total: 1, page: 1, limit: 25, pages: 1 },
}));
vi.mock('$lib/api.js', () => ({
  dataApi: {
    list: (c: string, p?: Record<string, string>) => list(c, p),
    delete: vi.fn(),
    bulkDelete: vi.fn(),
  },
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$lib/stores/realtime.svelte.js', () => ({ realtime: { onCollection: () => () => {} } }));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/collections/orders') } }));

import CollectionDataTable from './CollectionDataTable.svelte';
import type { CollectionField } from './types.js';

const fields: CollectionField[] = [{ name: 'title', type: 'text' }];

function mount(collectionName: string) {
  return render(CollectionDataTable, {
    props: {
      collectionName,
      customFields: fields,
      tableColumns: fields,
      m2oTargetMap: {},
      onCreate: vi.fn(),
      onEdit: vi.fn(),
    },
  });
}

beforeEach(() => list.mockClear());
afterEach(cleanup);

describe('CollectionDataTable', () => {
  it('drops search, sort and page when the collection changes', async () => {
    const { getByPlaceholderText, getAllByText, rerender } = mount('orders');
    await waitFor(() => expect(list).toHaveBeenCalled());

    // Search and sort within the first collection.
    const search = getByPlaceholderText(/search/i) as HTMLInputElement;
    search.value = 'cluj';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    getAllByText('Title')[0].click();
    await waitFor(() => expect(list.mock.calls.at(-1)?.[1]?.sort).toBe('title'));

    list.mockClear();
    await rerender({ collectionName: 'invoices' });
    await waitFor(() => expect(list).toHaveBeenCalledWith('invoices', expect.anything()));
    const params = list.mock.calls.at(-1)?.[1] ?? {};
    expect(params.sort).toBeUndefined();
    expect(params.search).toBeUndefined();
    expect(params.page).toBe('1');
  });
});
