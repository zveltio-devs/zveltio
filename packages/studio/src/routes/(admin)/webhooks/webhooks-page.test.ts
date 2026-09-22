import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing a webhook used to overwrite its signing secret with the mask.
 *
 * `GET /api/webhooks` masks the secret — the engine never sends the plaintext —
 * and the edit dialog copied that masked value into its form field. Saving
 * after changing only the URL sent `secret: '••••••••'`, which the engine
 * encrypted and stored, so every later delivery was signed with eight bullet
 * characters and every receiver's HMAC check failed. Nothing on screen said so.
 */
const { list, update } = vi.hoisted(() => ({
  list: vi.fn(async () => [
    {
      id: 'w1',
      name: 'Billing',
      url: 'https://example.com/hook',
      method: 'POST',
      events: ['data.create'],
      collections: [],
      active: true,
      secret: '••••••••',
      retry_attempts: 3,
      timeout: 5000,
    },
  ]),
  update: vi.fn(async (_id: string, _data: Record<string, unknown>) => ({})),
}));

vi.mock('$lib/api.js', () => ({
  webhooksApi: { list, update, create: vi.fn(), delete: vi.fn(), test: vi.fn() },
  collectionsApi: { list: vi.fn(async () => ({ collections: [] })) },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), undoable: vi.fn() },
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/webhooks') } }));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn() }));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('webhooks — the signing secret', () => {
  it('does not send the mask back when the secret is left alone', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Billing'));

    const edit = [...container.querySelectorAll('button')].find((b) =>
      /edit/i.test(b.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement;
    edit.click();

    const field = await waitFor(() => {
      const el = document.querySelector('#webhook-secret') as HTMLInputElement;
      if (!el) throw new Error('no secret field');
      return el;
    });
    // The field opens EMPTY, not pre-filled with the mask.
    expect(field.value).toBe('');

    const submit = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('type') === 'submit',
    ) as HTMLButtonElement;
    submit.click();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ secret: undefined });
  });

  it('sends a secret the operator actually typed', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('Billing'));
    (
      [...container.querySelectorAll('button')].find((b) =>
        /edit/i.test(b.getAttribute('aria-label') ?? ''),
      ) as HTMLButtonElement
    ).click();

    const field = await waitFor(() => {
      const el = document.querySelector('#webhook-secret') as HTMLInputElement;
      if (!el) throw new Error('no secret field');
      return el;
    });
    field.value = 'a-new-secret';
    field.dispatchEvent(new Event('input', { bubbles: true }));

    (
      [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('type') === 'submit',
      ) as HTMLButtonElement
    ).click();

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ secret: 'a-new-secret' });
  });
});
