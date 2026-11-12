import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/flows takes `trigger: { type, collection?, cron? }`. The page sent
 * `trigger_type` and `trigger_config` instead, so the engine answered 400 and
 * no flow could be created from Studio.
 */
const { post } = vi.hoisted(() => ({
  post: vi.fn(async (_path: string, body: Record<string, unknown>) => ({
    flow: { id: 'f1', name: body.name, trigger_type: 'cron', trigger_config: {}, is_active: true },
  })),
}));

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}` }));
vi.mock('#lib/api.js', () => ({
  api: { get: vi.fn(async () => ({ flows: [], total: 0 })), post },
  heldRoles: vi.fn(async () => ['member']),
  defaultRunAsRole: vi.fn(() => 'member'),
}));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import Page from './+page.svelte';

afterEach(cleanup);

describe('flow create', () => {
  it('sends the trigger the engine expects', async () => {
    const { container, getAllByText } = render(Page);
    await fireEvent.click(getAllByText('Create Flow')[0]);

    const nameInput = await waitFor(() => {
      const el = container.ownerDocument.getElementById('flow-name') as HTMLInputElement | null;
      if (!el) throw new Error('modal not open');
      return el;
    });
    await fireEvent.input(nameInput, { target: { value: 'Nightly' } });
    const select = container.ownerDocument.getElementById('flow-trigger') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'cron' } });

    const submit = [...container.ownerDocument.querySelectorAll('button.btn-primary')].at(
      -1,
    ) as HTMLButtonElement;
    await fireEvent.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalled());
    const body = post.mock.calls[0][1];
    expect(body.trigger).toEqual({ type: 'cron', cron: '0 * * * *' });
    expect(body).not.toHaveProperty('trigger_type');
    expect(body).not.toHaveProperty('trigger_config');
  });
});
