import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings archetype renders a singleton config (LDAP, SAML, ANAF). Two of
 * its defects are user-visible: an action's success toast ran the message key
 * through interpolation before lookup, so it printed the key; and a clipboard
 * copy reported success even when `writeText` rejected.
 */
const get = vi.fn(async () => ({ config: { host: 'ldap.example' } }));
const post = vi.fn(async (_url: string, _body?: unknown) => ({}));
vi.mock('$lib/api.js', () => ({
  api: {
    get: () => get(),
    post: (url: string, body: unknown) => post(url, body),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    fetch: vi.fn(),
  },
}));

const success = vi.fn();
const error = vi.fn();
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}));

const schema = {
  kind: 'settings',
  title: 'ldap.title',
  dataSource: '/ext/ldap/config',
  dataPath: 'config',
  saveEndpoint: '/ext/ldap/config',
  fields: [{ name: 'host', label: 'host' }],
  info: [{ label: 'callback', value: '{ENGINE_URL}/ext/ldap/callback' }],
  actions: [{ id: 'test', label: 'common.save', endpoint: '/ext/ldap/test' }],
};

beforeEach(() => {
  success.mockClear();
  error.mockClear();
});
afterEach(cleanup);

// biome-ignore lint/suspicious/noExplicitAny: the renderer takes the schema shape
const props = { schema: schema as any, extName: 'ldap' };

describe('SettingsPage action toast', () => {
  it('translates the label instead of looking up an interpolated key', async () => {
    const { default: SettingsPage } = await import('./SettingsPage.svelte');
    const { container } = render(SettingsPage, { props });

    const actionBtn = () => container.querySelector<HTMLButtonElement>('button.btn-outline');
    await waitFor(() => expect(actionBtn()).toBeTruthy());
    await fireEvent.click(actionBtn()!);
    await waitFor(() => expect(post).toHaveBeenCalled());
    // `t(\`${a.label} ✓\`)` looked up "common.save ✓", which no catalogue
    // has, so the toast printed the raw key.
    expect(success).toHaveBeenCalledWith('Save ✓');
  }, 60_000);
});

describe('SettingsPage copy', () => {
  it('reports a clipboard failure instead of claiming success', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    const { default: SettingsPage } = await import('./SettingsPage.svelte');
    const { container } = render(SettingsPage, { props });

    await waitFor(() => expect(container.querySelector('button.btn-ghost')).toBeTruthy());
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.btn-ghost')!);

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(success).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  }, 60_000);
});
