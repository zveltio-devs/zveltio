import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The record drawer is reused for every record of a collection: one instance is
 * mounted by the collection page and `openEdit()` is called again and again.
 * Everything it caches between those calls — the revision history, the relation
 * dropdowns — has to belong to the record currently on screen.
 */
const get = vi.fn(async (url: string) => {
  if (url.includes('record_id=rec-a'))
    return {
      revisions: [
        {
          id: 'rev-a',
          action: 'update',
          delta: { title: 1 },
          user_email: 'a@x',
          user_id: null,
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
  if (url.includes('record_id=rec-b'))
    return {
      revisions: [
        {
          id: 'rev-b',
          action: 'create',
          delta: null,
          user_email: 'b@x',
          user_id: null,
          created_at: '2026-01-02T00:00:00Z',
        },
      ],
    };
  return { revisions: [] };
});
const update = vi.fn(async (_c: string, _id: string, _body: unknown) => ({}));
const listRecords = vi.fn(async (_c: string, _p?: unknown) => ({ records: [], pagination: {} }));
vi.mock('$lib/api.js', () => ({
  api: {
    get: (url: string) => get(url),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    fetch: vi.fn(),
  },
  dataApi: {
    list: (c: string, p?: unknown) => listRecords(c, p),
    create: vi.fn(async () => ({})),
    update: (c: string, id: string, b: unknown) => update(c, id, b),
    delete: vi.fn(),
    bulkDelete: vi.fn(),
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import RecordDrawer from './RecordDrawer.svelte';
import type { CollectionField } from './types.js';

const fields: CollectionField[] = [{ name: 'title', label: 'Title', type: 'text' }];

function mount(extra: CollectionField[] = fields): any {
  return render(RecordDrawer, {
    props: {
      collectionName: 'orders',
      insertableFields: extra,
      onSaved: vi.fn(),
      onGoToSchema: vi.fn(),
    },
  });
}

beforeEach(() => {
  get.mockClear();
  update.mockClear();
  listRecords.mockClear();
});
afterEach(cleanup);

describe('RecordDrawer', () => {
  it('does not show the previous record history after opening another record', async () => {
    const { component, getByText, queryByText } = mount();
    component.openEdit({ id: 'rec-a', title: 'A' });
    await waitFor(() => getByText(/History/i));
    await fireEvent.click(getByText(/History/i));
    await waitFor(() => getByText(/a@x/));

    component.openEdit({ id: 'rec-b', title: 'B' });
    await waitFor(() => expect(queryByText(/a@x/)).toBeNull());
  });

  it('sends an explicit null when a text field is cleared in edit mode', async () => {
    const { component, getByLabelText, getByText } = mount();
    component.openEdit({ id: 'rec-a', title: 'A' });
    await waitFor(() => getByLabelText('Title'));
    await fireEvent.input(getByLabelText('Title'), { target: { value: '' } });
    await fireEvent.click(getByText(/update record|save record/i));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][2]).toHaveProperty('title', null);
  });

  it('does not claim the related collection is empty when its fetch failed', async () => {
    listRecords.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const { component, findByText, queryByText } = mount([
      {
        name: 'customer_id',
        label: 'Customer',
        type: 'm2o',
        options: { related_collection: 'customers' },
      },
    ]);
    component.openCreate();
    // The server's own words, not an empty dropdown plus "no records in customers".
    expect(await findByText('boom')).toBeTruthy();
    expect(queryByText(/No records in/i)).toBeNull();
  });
});
