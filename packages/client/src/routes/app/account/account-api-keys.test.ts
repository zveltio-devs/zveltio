/**
 * The member's own API keys on /app/account (ADR 0010): the key carries the
 * actions ticked per collection and nothing else, and the raw key is shown once.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const apiKeys = vi.hoisted(() => ({
  list: vi.fn(async () => ({ api_keys: [] })),
  create: vi.fn(async () => ({ key: 'zv_raw_once' })),
  revoke: vi.fn(),
}));
vi.mock('#lib/zveltio.js', () => ({ client: { auth: { apiKeys } } }));
vi.mock('#lib/auth-client.js', () => ({
  authClient: {
    listSessions: async () => ({ data: [] }),
    useSession: () => ({ get: () => ({ data: null }) }),
  },
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

const { default: Page } = await import('./+page.svelte');

describe('/app/account API keys', () => {
  it('issues a key scoped to the ticked actions and shows it once', async () => {
    render(Page, {
      props: {
        data: {
          user: { id: 'u1', email: 'a@x', name: 'A' },
          collections: [
            { name: 'tasks', display_name: 'Tasks' },
            { name: 'notes', display_name: null },
          ],
        },
      } as never,
    });
    await fireEvent.click(screen.getByLabelText('read Tasks'));
    await fireEvent.click(screen.getByLabelText('update Tasks'));
    await fireEvent.input(screen.getAllByLabelText('Name')[1]!, { target: { value: 'ci' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Issue key' }));

    await waitFor(() => expect(apiKeys.create).toHaveBeenCalledOnce());
    const input = (apiKeys.create.mock.calls[0] as unknown[])[0] as {
      name: string;
      scopes: unknown;
    };
    expect(input.name).toBe('ci');
    expect(input.scopes).toEqual([{ collection: 'tasks', actions: ['read', 'update'] }]);
    expect(await screen.findByText('zv_raw_once')).toBeTruthy();
  });
});
