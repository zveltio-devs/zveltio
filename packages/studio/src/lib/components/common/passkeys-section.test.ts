import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every other network call in the Studio goes through `$lib/api.js`, which adds
 * the engine base URL and the `x-tenant-slug` header. This section reached for
 * the global `fetch` instead, so on any install where the Studio and the engine
 * are not the same origin it asked its own origin for the passkey list, got a
 * 404, and — because `load()` swallows a failed response into an empty array —
 * told the user they had no passkeys registered.
 *
 * The login page runs the same WebAuthn ceremony through `api.fetch`; this is
 * the one place that did not.
 */
const apiFetch = vi.fn(
  async (_path: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ passkeys: [] }), { status: 200 }),
);
vi.mock('$lib/api.js', () => ({
  api: { fetch: (path: string, init?: RequestInit) => apiFetch(path, init) },
}));
vi.mock('$lib/stores/toast.svelte.js', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn() }));

import PasskeysSection from './PasskeysSection.svelte';

afterEach(() => {
  cleanup();
  apiFetch.mockClear();
});

describe('PasskeysSection', () => {
  it('lists passkeys through the api client, not the bare global fetch', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    render(PasskeysSection);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(apiFetch.mock.calls[0]?.[0]).toBe('/api/auth/passkey/list-user-passkeys');
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('renders the unsupported notice instead of throwing on a browser without WebAuthn', async () => {
    // jsdom has no `PublicKeyCredential`, so this is the branch a Firefox or
    // Safari user without a platform authenticator sees. It referenced
    // `passkeys.unsupportedLong`, which is in none of the nine catalogues —
    // the message proxy returned undefined and calling it took the account
    // page down. No test rendered this branch, so nothing said so.
    const { findByText } = render(PasskeysSection);
    expect(await findByText('This browser does not support passkeys')).toBeTruthy();
  });
});
