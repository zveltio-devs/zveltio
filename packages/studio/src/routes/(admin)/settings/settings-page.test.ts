import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed load used to arm the Save button with the form's own defaults.
 *
 * `onMount` had a `try`/`finally` and no `catch`: when `settingsApi.getAll()`
 * rejected — a 403, a restarting engine — the fields kept their declared
 * defaults (`app_name: 'Zveltio'`, registration off, a 24-hour session, empty
 * locale and timezone) and nothing on the screen said the load had failed. The
 * next click on Save wrote all of that over the instance's real configuration.
 */
const { getAll, updateBulk } = vi.hoisted(() => ({
  getAll: vi.fn(),
  // Typed: an untyped `vi.fn()` infers its arguments as the empty tuple, and
  // `mock.calls[0][0]` below then fails typecheck with TS2493.
  updateBulk: vi.fn(async (_settings: Record<string, unknown>) => ({})),
}));

vi.mock('$lib/api.js', () => ({
  api: { get: vi.fn(async () => ({ rate_limits: [] })), post: vi.fn(), patch: vi.fn() },
  settingsApi: { getAll, updateBulk },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('$lib/auth.svelte.js', () => ({ auth: { user: { id: 'u1', role: 'god' } } }));

import Page from './+page.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function saveButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => /save/i.test(b.textContent ?? '')) as
    | HTMLButtonElement
    | undefined;
}

describe('settings — a load that failed', () => {
  it('disables Save and never writes the defaults', async () => {
    getAll.mockRejectedValueOnce(new Error('Admin access required'));
    const { container } = render(Page);

    await waitFor(() => expect(document.body.textContent).toContain('Admin access required'));

    const save = saveButton(container);
    expect(save?.disabled).toBe(true);
    save?.click();
    await Promise.resolve();
    expect(updateBulk).not.toHaveBeenCalled();
  });

  it('saves normally once the settings have been read', async () => {
    getAll.mockResolvedValueOnce({ app_name: 'Primăria', session_expiry_hours: 8 });
    const { container } = render(Page);

    await waitFor(() => expect(saveButton(container)?.disabled).toBe(false));
    saveButton(container)?.click();

    await waitFor(() => expect(updateBulk).toHaveBeenCalledTimes(1));
    // What it sends is what was loaded, not the component's defaults.
    expect(updateBulk.mock.calls[0][0]).toMatchObject({
      app_name: 'Primăria',
      session_expiry_hours: 8,
    });
  });
});
