import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two ways an extension could be present in the catalogue and unreachable
 * from this page.
 *
 * The category sidebar was a hardcoded list of eighteen names, and the
 * extensions on disk had drifted past it: `billing`, `forms`, `intelligence`,
 * `search` and `sms` had no entry, so filtering could never reach them. The
 * list is now derived from the catalogue itself.
 *
 * The search box lowercased the query and then compared it against each tag
 * verbatim, so a tag carrying any uppercase letter never matched anything the
 * user could type.
 */
function ext(name: string, category: string, tags: string[] = []) {
  return {
    name,
    displayName: name,
    description: '',
    category,
    version: '1.0.0',
    author: 'zveltio',
    tags,
    is_installed: false,
    is_enabled: false,
    is_running: false,
    needs_restart: false,
    files_on_disk: true,
    config: {},
  };
}

// Installed from the registry at 1.0.0; the registry serves 1.2.0.
const outdated = {
  ...ext('crm-ext', 'billing'),
  is_installed: true,
  is_enabled: true,
  is_running: true,
  installed_version: '1.0.0',
  catalog_version: '1.2.0',
  version: '1.2.0',
  update_available: true,
};

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => ({ extensions: [] as unknown[], version: '1.2.0' }),
  })),
}));
vi.mock('#lib/api.js', () => ({ api: { fetch: apiFetch } }));
vi.mock('#lib/step-up.svelte.js', () => ({
  StepUpEnrollmentRequired: class extends Error {},
  stepUpAborted: () => false,
  stepUpHeaders: vi.fn(async (action: string) => ({ 'X-Zveltio-Step-Up': `token:${action}` })),
}));
vi.mock('#lib/stores/toast.svelte.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('#lib/extensions.svelte.js', () => ({ refreshExtensions: vi.fn() }));

import Page from './+page.svelte';

beforeEach(() => {
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      extensions: [
        ext('billing-ext', 'billing', ['Invoices']),
        ext('ai-ext', 'ai', ['llm']),
        outdated,
      ],
      version: '1.2.0',
    }),
  }));
});

afterEach(cleanup);

const sidebarLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('nav button')].map((b) => b.textContent?.trim());

describe('marketplace catalogue', () => {
  it('lists every category the catalogue actually uses', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('billing-ext'));
    expect(sidebarLabels(container)).toEqual(expect.arrayContaining(['ai', 'billing']));
  });

  it('filters to a category that no hardcoded list contained', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('billing-ext'));

    const billing = [...container.querySelectorAll('nav button')].find(
      (b) => b.textContent?.trim() === 'billing',
    ) as HTMLButtonElement;
    billing.click();

    await waitFor(() => expect(document.body.textContent).not.toContain('ai-ext'));
    expect(document.body.textContent).toContain('billing-ext');
  });

  it('matches a tag whatever case it was published in', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('billing-ext'));

    const search = container.querySelector('input[type="text"]') as HTMLInputElement;
    search.value = 'invoices';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    await waitFor(() => expect(document.body.textContent).not.toContain('ai-ext'));
    expect(document.body.textContent).toContain('billing-ext');
  });
});

describe('marketplace update', () => {
  it('shows the installed version and updates behind a step-up', async () => {
    const { container } = render(Page);
    await waitFor(() => expect(document.body.textContent).toContain('crm-ext'));
    expect(document.body.textContent).toContain('v1.0.0');
    expect(document.body.textContent).toContain('1.2.0');

    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Update',
    ) as HTMLButtonElement;
    expect(
      [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Update'),
    ).toHaveLength(1);
    button.click();

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/marketplace/crm-ext/update',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Zveltio-Step-Up': 'token:extension.update:crm-ext',
          }),
        }),
      ),
    );
  });
});
