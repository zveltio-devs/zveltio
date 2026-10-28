import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The theme editor (ADR 0007): a pasted daisyUI theme becomes data and shows in
 * the preview, a value that is not a colour holds Save shut, and a tenant that
 * resets goes back to the instance's theme (`null`), not to daisyUI's defaults.
 */
const { get, put, update } = vi.hoisted(() => ({
  get: vi.fn(async (url: string): Promise<unknown> => {
    if (url === '/api/settings/theme') return { value: { colors: { primary: '#112233' } } };
    return { theme: null };
  }),
  put: vi.fn(async (_url: string, body: { theme: unknown }) => body),
  update: vi.fn(async (_key: string, _value: unknown) => ({})),
}));
vi.mock('#lib/api.js', () => ({ api: { get, put }, settingsApi: { update } }));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import ThemeEditor from './ThemeEditor.svelte';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const preview = () => screen.getByTestId('theme-preview');
const token = (k: string) => preview().style.getPropertyValue(`--color-${k}`).trim();

describe('theme editor', () => {
  it('imports a daisyUI theme into the preview and saves it as data', async () => {
    render(ThemeEditor);
    await waitFor(() => expect(token('primary')).toBe('#112233'));
    await fireEvent.input(screen.getByLabelText(/Import a daisyUI theme/), {
      target: {
        value: `[data-theme=x]{color-scheme:dark;--color-primary:oklch(58% 0.233 277.117);--color-accent:red;background:url(x);--radius-box:0.5rem}`,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(preview().getAttribute('data-theme')).toBe('dark');
    expect(token('primary')).toBe('oklch(58% 0.233 277.117)');
    expect(token('accent')).toBe('');
    await fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]).toEqual([
      'theme',
      {
        scheme: 'dark',
        colors: { primary: 'oklch(58% 0.233 277.117)' },
        radius: { box: '0.5rem' },
      },
    ]);
  });

  it('holds Save shut while a colour is not a colour', async () => {
    render(ThemeEditor);
    const primary = await screen.findByRole('textbox', { name: 'primary' });
    await fireEvent.input(primary, { target: { value: 'red;background:url(x)' } });
    expect((screen.getByRole('button', { name: 'Save theme' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(preview().getAttribute('style') ?? '').not.toContain('url(');
  });

  it('resets a tenant to the instance theme, not to the defaults', async () => {
    render(ThemeEditor);
    const target = await screen.findByLabelText('Applies to');
    await fireEvent.change(target, { target: { value: 'tenant' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Use the instance theme' }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/api/tenants/current/theme', { theme: null }),
    );
    expect(update).not.toHaveBeenCalled();
  });
});
