import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `ConfirmModal` leaves `open` to its caller. This page never cleared it, so
 * after deleting a policy the dialog stayed up over the reloaded table and a
 * second Confirm re-sent the DELETE for a row that no longer existed.
 */
const { del } = vi.hoisted(() => ({ del: vi.fn(async () => ({})) }));
vi.mock('$lib/api.js', () => ({
  api: {
    get: vi.fn(async (path: string) => {
      if (path === '/api/admin/rls') {
        return {
          policies: [
            {
              id: 'p1',
              collection: 'invoices',
              role: '*',
              filter_field: 'created_by',
              filter_op: 'eq',
              filter_value_source: 'user_id',
              is_enabled: true,
              description: 'own records',
            },
          ],
        };
      }
      if (path === '/api/collections') return { collections: [{ name: 'invoices' }] };
      return { roles: [] };
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: del,
  },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Page from './+page.svelte';

afterEach(cleanup);

describe('rls — delete confirmation', () => {
  it('closes the dialog once the policy is deleted', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('invoices'));

    const buttons = [...container.querySelectorAll('button')];
    (buttons[buttons.length - 1] as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());

    const confirm = document.querySelector('[role="dialog"] .modal-action .btn-error');
    (confirm as HTMLButtonElement).click();

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });
});
