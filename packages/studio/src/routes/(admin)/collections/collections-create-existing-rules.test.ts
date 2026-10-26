import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A create refused because access rules already name the collection (409
 * `existing_rules`, A13) shows those rules and offers to adopt them: the retry
 * carries `adopt_rules: true`. Without the panel the admin saw a prose error
 * and had no way to create the collection short of deleting the rules.
 */
const RULE = { ptype: 'p', subject: 'editor', domain: '*', object: 'orders', action: 'read' };
const create = vi.fn();
vi.mock('#lib/api.js', () => ({
  collectionsApi: {
    list: vi.fn(async () => ({ collections: [] })),
    fieldTypes: vi.fn(async () => ({
      field_types: [{ type: 'text', label: 'Text', category: 'text' }],
    })),
    create: (data: unknown) => create(data),
    delete: vi.fn(),
  },
}));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$app/navigation', () => ({ replaceState: vi.fn(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/collections?new=1') },
}));

import Page from './+page.svelte';

afterEach(cleanup);

describe('collections create — rules that already name it', () => {
  it('lists the rules and retries with adopt_rules when the admin adopts them', async () => {
    create
      .mockRejectedValueOnce(
        Object.assign(new Error('Access rules already name orders'), {
          code: 'existing_rules',
          status: 409,
          rules: [RULE],
        }),
      )
      .mockResolvedValueOnce({ job_id: 'j1' });

    render(Page);
    const name = (await waitFor(() => {
      const el = document.getElementById('col-name');
      if (!el) throw new Error('create dialog not open');
      return el;
    })) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'orders' } });
    const fieldName = document.querySelector('input[placeholder="field_name"]') as HTMLInputElement;
    await fireEvent.input(fieldName, { target: { value: 'title' } });
    await fireEvent.submit(name.closest('form') as HTMLFormElement);

    const panel = await waitFor(() => {
      const el = document.querySelector('[data-testid="existing-rules"]');
      if (!el) throw new Error('no rules panel');
      return el as HTMLElement;
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty('adopt_rules');
    expect(panel.textContent).toContain('editor');
    expect(panel.textContent).toContain('read');

    await fireEvent.click(panel.querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0]).toMatchObject({ name: 'orders', adopt_rules: true });
  });
});
