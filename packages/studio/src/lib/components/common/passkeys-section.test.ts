import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every other network call in the Studio goes through `#lib/api.js`, which adds
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
vi.mock('#lib/api.js', () => ({
  api: { fetch: (path: string, init?: RequestInit) => apiFetch(path, init) },
}));
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('#lib/stores/toast.svelte.js', () => ({ toast }));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(async () => ({ id: 'att-1' })),
}));

import { fireEvent } from '@testing-library/svelte';
import { m } from '#lib/i18n.svelte.js';
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

/**
 * An account with no password (OAuth only) enrolls its first passkey from a fresh
 * OAuth sign-in; the engine says so (`first_factor`). The section asked for a
 * password anyway, and showed the engine's refusals as "HTTP 403".
 */
describe('PasskeysSection, first passkey on an account with no password', () => {
  const firstFactor = (rule: string) =>
    new Response(
      JSON.stringify({ code: 'step_up_enrollment_required', errors: { first_factor: rule } }),
      { status: 403 },
    );
  const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
  const register = async (verify: Response, rule = 'recent_sign_in') => {
    Object.assign(window, { PublicKeyCredential: () => {} });
    Object.assign(navigator, { credentials: { create: () => {} } });
    vi.spyOn(window, 'prompt').mockReturnValue('laptop');
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/auth/step-up/options') return firstFactor(rule);
      if (path.startsWith('/api/auth/passkey/generate-register-options')) return ok({});
      if (path === '/api/auth/passkey/verify-registration') return verify;
      return ok({ passkeys: [] });
    });
    const view = render(PasskeysSection);
    await fireEvent.click(await view.findByRole('button', { name: /add/i }));
    return view;
  };

  afterEach(() => {
    apiFetch.mockReset();
    toast.error.mockClear();
    toast.success.mockClear();
  });

  it('does not ask for a password after a fresh OAuth sign-in', async () => {
    const view = await register(ok());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const call = apiFetch.mock.calls.find((c) => c[0] === '/api/auth/passkey/verify-registration');
    expect(JSON.parse(call![1]!.body as string).password).toBeUndefined();
    expect(view.queryByLabelText(/password/i)).toBeNull();
  });

  it("shows the engine's refusal in words, not HTTP 403", async () => {
    await register(
      new Response(JSON.stringify({ code: 'recent_sign_in_required', detail: 'x' }), {
        status: 403,
      }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(m['passkeys.signInAgain']()));
  });

  it('sends a stale OAuth session to sign in again before any ceremony', async () => {
    await register(ok(), 'sign_in_again');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(m['passkeys.signInAgain']()));
    expect(apiFetch.mock.calls.some((c) => String(c[0]).includes('generate-register'))).toBe(false);
  });
});

/**
 * The first passkey on an account with a password: the engine checks the password
 * at verify-registration, after the browser ceremony. A wrong one refused only
 * there left a discoverable credential in the authenticator that the server never
 * stored. The section now checks it first and asks again on a wrong one.
 */
describe('PasskeysSection, first passkey confirmed with the password', () => {
  afterEach(() => {
    apiFetch.mockReset();
    toast.error.mockClear();
    toast.success.mockClear();
  });

  it('refuses a wrong password before the ceremony and asks again', async () => {
    Object.assign(window, { PublicKeyCredential: () => {} });
    Object.assign(navigator, { credentials: { create: () => {} } });
    vi.spyOn(window, 'prompt').mockReturnValue('laptop');
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/auth/step-up/options')
        return json(
          { code: 'step_up_enrollment_required', errors: { first_factor: 'password' } },
          403,
        );
      if (path === '/api/auth/step-up/check-password') {
        const { password } = JSON.parse(init!.body as string) as { password: string };
        return password === 'right-one'
          ? new Response(null, { status: 204 })
          : json({ code: 'password_required' }, 403);
      }
      if (path.startsWith('/api/auth/passkey/generate-register-options')) return json({});
      if (path === '/api/auth/passkey/verify-registration') return json({});
      return json({ passkeys: [] });
    });
    const view = render(PasskeysSection);
    await fireEvent.click(await view.findByRole('button', { name: /add/i }));
    const answer = async (pw: string) => {
      const input = await waitFor(() => {
        const el = document.querySelector<HTMLInputElement>('input[type="password"]');
        if (!el) throw new Error('no password prompt');
        return el;
      });
      await fireEvent.input(input, { target: { value: pw } });
      await fireEvent.submit(input.closest('form')!);
    };
    const ceremonyStarted = () =>
      apiFetch.mock.calls.some((c) => String(c[0]).includes('generate-register'));

    await answer('wrong-one');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(m['passkeys.passwordWrong']()));
    expect(ceremonyStarted()).toBe(false);

    await answer('right-one');
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const verify = apiFetch.mock.calls.find(
      (c) => c[0] === '/api/auth/passkey/verify-registration',
    );
    expect(JSON.parse(verify![1]!.body as string).password).toBe('right-one');
  });
});
