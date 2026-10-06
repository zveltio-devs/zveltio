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

/**
 * The drawer says `aria-modal="true"`, so a screen reader treats the page
 * behind it as gone. It has to behave like it: Escape bound to a backdrop that
 * never takes focus did nothing, focus stayed on the button that opened it, Tab
 * walked into the table behind, and closing dropped the keyboard at the top of
 * the document. And it announced "New record" while editing one.
 */
describe('RecordDrawer as a modal dialog', () => {
  // `focusables()`-style filters drop elements with a null offsetParent, which
  // jsdom reports for everything — see Modal.test.ts.
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  beforeEach(() =>
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    }),
  );
  afterEach(() => {
    if (desc) Object.defineProperty(HTMLElement.prototype, 'offsetParent', desc);
  });

  async function openFrom() {
    const opener = document.createElement('button');
    opener.textContent = 'open';
    document.body.appendChild(opener);
    opener.focus();
    const view = mount();
    view.component.openEdit({ id: 'rec-a', title: 'A' });
    const dialog = await view.findByRole('dialog');
    return { ...view, opener, dialog };
  }

  it('moves focus into the drawer when it opens', async () => {
    const { dialog } = await openFrom();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('closes on Escape pressed inside a field', async () => {
    const { getByLabelText, queryByRole } = await openFrom();
    await fireEvent.keyDown(getByLabelText('Title'), { key: 'Escape' });
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
  });

  it('keeps Tab inside the drawer', async () => {
    const { dialog } = await openFrom();
    const items = [
      ...(dialog as HTMLElement).querySelectorAll<HTMLElement>('button:not([disabled]), input'),
    ];
    const last = items[items.length - 1]!;
    last.focus();
    // jsdom does not move focus on Tab itself, so "still inside" proves
    // nothing; the trap has to wrap to the first control.
    await fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('gives focus back to what opened it on close', async () => {
    const { opener, getByLabelText, queryByRole } = await openFrom();
    await fireEvent.keyDown(getByLabelText('Title'), { key: 'Escape' });
    await waitFor(() => expect(queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it('is announced as editing when it edits a record', async () => {
    const { dialog } = await openFrom();
    expect(dialog).toHaveAccessibleName(/edit record/i);
  });
});
