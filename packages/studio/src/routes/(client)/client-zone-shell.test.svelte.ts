import { cleanup, render, waitFor } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The portal's sign-in page lives inside the `(client)` group, so this layout
 * wraps it. The layout rendered `children()` only for an authenticated
 * visitor, and redirected an anonymous one to that same sign-in page — which
 * therefore painted nothing. The portal could not be entered at all.
 */
import { pageState } from './page-state.mock.svelte.js';

const goto = vi.fn();
let authenticated = false;

vi.mock('$app/state', async () => ({
  page: (await import('./page-state.mock.svelte.js')).pageState,
}));
vi.mock('$app/navigation', () => ({
  goto: (...args: unknown[]) => goto(...args),
}));
vi.mock('$app/paths', () => ({ base: '/admin' }));
vi.mock('$lib/auth.svelte.js', () => ({
  auth: {
    init: async () => {},
    signOut: async () => {},
    get loading() {
      return false;
    },
    get isAuthenticated() {
      return authenticated;
    },
    get user() {
      return authenticated ? { name: 'Ana', email: 'ana@example.com' } : null;
    },
  },
}));
vi.mock('$lib/api.js', () => ({
  api: { get: async () => ({ site: null, nav: [] }) },
}));

const children = createRawSnippet(() => ({
  render: () => '<p>sign-in form</p>',
}));

beforeEach(() => {
  goto.mockClear();
  authenticated = false;
  pageState.url = new URL('http://localhost/admin/portal-client/login');
});
afterEach(cleanup);

// The layout pulls in the toast container, which pulls in the compiled
// Paraglide catalogue: the first transform of that tree is well past vitest's
// 5s default on a cold cache.
describe('(client) layout', { timeout: 30_000 }, () => {
  it('renders the sign-in page for an anonymous visitor', async () => {
    const Layout = (await import('./+layout.svelte')).default;
    const { findByText } = render(Layout, { children });

    expect(await findByText('sign-in form')).toBeTruthy();
    await waitFor(() => expect(goto).not.toHaveBeenCalled());
  });

  it('still sends an anonymous visitor on a portal page to sign-in', async () => {
    pageState.url = new URL('http://localhost/admin/portal-client/invoices');
    const Layout = (await import('./+layout.svelte')).default;
    render(Layout, { children });

    await waitFor(() => expect(goto).toHaveBeenCalledWith('/admin/portal-client/login'));
  });
});
