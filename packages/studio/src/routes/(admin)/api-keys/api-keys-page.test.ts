import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * An extension action gated on its own permission action (`approve` on a
 * resource) needs a key scoped to that action. The form offered only the four
 * data checkboxes, so such a key could not be made here.
 */
const { get, post } = vi.hoisted(() => ({
  get: vi.fn(async () => ({ api_keys: [], total: 0 })),
  post: vi.fn(async (_path: string, _body: unknown) => ({
    id: 'k1',
    key: 'zvk_x',
    key_prefix: 'zvk_x',
  })),
}));

vi.mock('#lib/api.js', () => ({ api: { get, post, delete: vi.fn() } }));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('#lib/extensions.svelte.js', () => ({ extensions: { active: [] } }));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/api-keys?new=1') },
}));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('a typed action rides next to the ticked ones', async () => {
  render(Page);
  // The dialog renders in a portal on <body>, outside the render container.
  const container = document;
  const typed = await waitFor(() => {
    const el = container.querySelector<HTMLInputElement>('input[placeholder="approve, …"]');
    if (!el) throw new Error('no typed-actions input');
    return el;
  });
  const name = container.querySelector<HTMLInputElement>('#api-key-name')!;
  await fireEvent.input(name, { target: { value: 'approver' } });
  await fireEvent.change(typed, { target: { value: 'approve, read' } });
  await fireEvent.submit(name.closest('form')!);

  await waitFor(() => expect(post).toHaveBeenCalled());
  const body = post.mock.calls[0]![1] as {
    scopes: Array<{ collection: string; actions: string[] }>;
  };
  expect(body.scopes).toEqual([
    { collection: '*', actions: ['read', 'create', 'update', 'delete', 'approve'] },
  ]);
});
