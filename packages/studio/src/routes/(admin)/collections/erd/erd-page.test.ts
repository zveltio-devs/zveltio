import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed schema fetch must say so.
 *
 * `load()` had a `try/finally` and no `catch`, so a rejected request left the
 * page on its empty state — "No collections yet", with a button to create the
 * first one — on an instance that has all of them. The rejection also escaped
 * the `onMount` callback before the `mousemove`/`mouseup` listeners were
 * registered, so the canvas stayed undraggable with nothing on screen to
 * explain either.
 */
const error = vi.hoisted(() => vi.fn());
vi.mock('$lib/api.js', () => ({
  collectionsApi: {
    list: vi.fn(async () => {
      throw new Error('boom');
    }),
    create: vi.fn(),
    delete: vi.fn(),
  },
  api: {
    get: vi.fn(async () => ({})),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error, success: vi.fn() } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import Page from './+page.svelte';

afterEach(cleanup);

describe('ERD — a failed load', () => {
  it('reports the failure instead of showing an empty schema', async () => {
    render(Page);
    await waitFor(() => expect(error).toHaveBeenCalled());
  });

  it('still arms the drag listeners', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    render(Page);
    await waitFor(() => expect(add.mock.calls.some(([type]) => type === 'mousemove')).toBe(true));
    add.mockRestore();
  });
});
