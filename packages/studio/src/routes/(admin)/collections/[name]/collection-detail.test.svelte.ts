import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * One page instance serves every collection.
 *
 * The route parameter changes and the component does not remount, so walking
 * quickly through the collections list leaves two loads in flight. The loader
 * assigned whatever arrived, so the slower FIRST response landed last and
 * painted the previous collection's schema under the current collection's name.
 *
 * `.test.svelte.ts` rather than `.test.ts`: the mocked `$app/state` has to be a
 * rune for the page's `$derived` parameter to react to it at all, and it lives
 * in `page-state.mock.svelte.ts` because a mock factory importing this file
 * back deadlocks the dynamic import of the page.
 */
import { pageState } from './page-state.mock.svelte.js';

const gate: Record<string, { release: () => void; promise: Promise<void> }> = {};
function barrier(name: string) {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  gate[name] = { release, promise };
}
barrier('orders');
barrier('invoices');

vi.mock('$app/state', async () => ({
  page: (await import('./page-state.mock.svelte.js')).pageState,
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/auth.svelte.js', () => ({ auth: { user: { id: 'u1' } } }));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$lib/stores/realtime.svelte.js', () => ({ realtime: { onCollection: () => () => {} } }));
vi.mock('$lib/api.js', () => ({
  collectionsApi: {
    get: async (name: string) => {
      await gate[name]!.promise;
      return {
        collection: { name, display_name: name === 'orders' ? 'Orders' : 'Invoices', fields: [] },
      };
    },
    fieldTypes: async () => ({ field_types: [] }),
    list: async () => ({ collections: [] }),
  },
  dataApi: {
    list: async () => ({ records: [], pagination: { total: 0, page: 1, limit: 25, pages: 1 } }),
  },
  api: {
    get: async () => ({ relations: [] }),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

afterEach(cleanup);

describe('collection detail — two loads in flight', () => {
  it('discards the response of the collection the user has already left', async () => {
    render((await import('./+page.svelte')).default);

    // Move to the second collection while the first request is still out, then
    // let the FIRST one answer last.
    pageState.params = { name: 'invoices' };
    await new Promise((r) => setTimeout(r, 20));
    gate.invoices!.release();
    await waitFor(() => expect(document.body.textContent).toContain('Invoices'), { timeout: 1500 });
    gate.orders!.release();

    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.textContent).toContain('Invoices');
    expect(document.body.textContent).not.toContain('Orders');
  }, 45_000);
});
