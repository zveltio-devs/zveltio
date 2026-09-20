/**
 * Both sign-in paths must honour `?redirect=`.
 *
 * The login page has two: a password form and a passkey ceremony, fifty lines
 * apart. The password path ended in `goto(redirectTo)` — the validated deep
 * link — and the passkey path ended in `goto(base + '/')`, so a person bounced
 * off `/admin/users` and returning with a passkey landed on the dashboard
 * instead. Proximity read as consistency; it was not.
 *
 * The page is mounted for real. A test that called a copy of the function
 * would not have caught it, because the defect was in the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

const goto = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({ goto, invalidateAll: vi.fn(), afterNavigate: vi.fn() }));
vi.mock('$app/state', () => ({
  page: {
    url: new URL('http://localhost:5173/admin/login?redirect=%2Fadmin%2Fusers'),
    params: {},
    status: 200,
    error: null,
    data: {},
  },
  navigating: null,
}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'cred-1', response: {} })),
}));

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe('login — the passkey path and the deep link', () => {
  beforeEach(() => {
    // jsdom has neither, and `browserSupportsPasskey()` refuses without them.
    (globalThis as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential =
      function PublicKeyCredential() {};
    Object.defineProperty(globalThis.navigator, 'credentials', {
      configurable: true,
      value: { get: vi.fn(async () => ({})) },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) return ok({});
      if (url.includes('generate-authenticate-options')) return ok({ challenge: 'x' });
      if (url.includes('verify-authentication')) return ok({ verified: true });
      if (url.includes('/api/me')) return ok({ user: { id: 'u1' } });
      return ok({});
    }) as typeof fetch;
  });

  it('sends the user to the page they were bounced from', async () => {
    goto.mockClear();
    const Login = (await import('./+page.svelte')).default;
    const { getByRole } = render(Login);

    getByRole('button', { name: /passkey/i }).click();
    await vi.waitFor(() => expect(goto).toHaveBeenCalled());

    expect(goto).toHaveBeenCalledWith('/admin/users');
    // 30s: importing the real page pulls the Paraglide bundle and thirty icon
    // components through the Svelte compiler. Mounting it is the point — a test
    // against a copy of the function could not have caught this.
  }, 30_000);
});
