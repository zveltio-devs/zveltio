import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The members table shadowed the message catalogue.
 *
 * `m` is the catalogue imported at the top of the page, and the members loop
 * was written `{#each … as m}`, which shadows it for the whole block. The very
 * next line called `m['tenants.removeMember']()` — a property of the member
 * object, so `undefined` — and the table threw as soon as a tenant had one
 * member. A tenant with no members rendered fine, which is why it survived.
 *
 * Removing a member also went straight through; it is the one destructive
 * action on this screen that asked nothing first.
 */
const { del } = vi.hoisted(() => ({ del: vi.fn(async () => ({})) }));
vi.mock('$lib/api.js', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === '/api/tenants') {
        return { tenants: [{ id: 't1', name: 'Acme', slug: 'acme', status: 'active' }] };
      }
      if (path.endsWith('/environments')) return { environments: [] };
      if (path.endsWith('/members')) {
        return { members: [{ user_id: 'u1', email: 'ana@example.com', role: 'admin' }] };
      }
      return {};
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: del,
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Page from './+page.svelte';

afterEach(cleanup);

describe('tenants — members table', () => {
  it('renders a member without throwing on the shadowed catalogue', async () => {
    const { getByText, container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Acme'));

    // Expand the tenant row: environments AND members load from here.
    const expand = container.querySelector('button[data-tip]') as HTMLButtonElement;
    expand.click();

    await waitFor(() => expect(document.body.textContent).toContain('ana@example.com'));
    expect(getByText('ana@example.com')).toBeTruthy();
  });

  it('asks before removing a member and does not delete until confirmed', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Acme'));
    (container.querySelector('button[data-tip]') as HTMLButtonElement).click();
    await waitFor(() => expect(document.body.textContent).toContain('ana@example.com'));

    const remove = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('title')?.match(/member/i),
    ) as HTMLButtonElement;
    remove.click();

    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    expect(del).not.toHaveBeenCalled();
  });
});
