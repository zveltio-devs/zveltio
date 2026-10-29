import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The page a terminal opens to be signed in, or to have one change confirmed. */
const { get, post } = vi.hoisted(() => ({
  get: vi.fn(async (_path: string) => ({
    code: 'BCDF-GHJK',
    kind: 'step-up',
    action: 'extension.update:crm',
    ip: '10.0.0.7',
    user_agent: 'zveltio-cli',
    created_at: new Date().toISOString(),
    for_this_account: true,
  })),
  post: vi.fn(async (_path: string, _body?: unknown) => ({})),
}));
vi.mock('#lib/api.js', () => ({ api: { get, post } }));
vi.mock('#lib/step-up.svelte.js', () => ({ stepUpAborted: () => false }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/admin/cli-sign-in?code=BCDF-GHJK') },
}));

import Page from './+page.svelte';

afterEach(cleanup);

describe('CLI confirmation page', () => {
  it('shows what the terminal asks and approves that code', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('extension.update:crm'));
    expect(get).toHaveBeenCalledWith('/api/auth/cli/request?code=BCDF-GHJK');
    expect(document.body.textContent).toContain('10.0.0.7');

    const approve = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve'),
    ) as HTMLButtonElement;
    approve.click();
    await waitFor(() => expect(document.body.textContent).toContain('Go back to your terminal'));
    expect(post).toHaveBeenCalledWith('/api/auth/cli/approve', { code: 'BCDF-GHJK' });
  });
});
