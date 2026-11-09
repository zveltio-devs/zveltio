import { api, clearApiCache } from './api.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
let currentUser = $state<any>(null);
let loading = $state(true);

/**
 * Every assignment of the signed-in user goes through here, so that the one
 * rule — a new identity gets none of the previous one's cached responses —
 * lives in a single place. Sign-in, sign-out, passkey verification and a
 * session that simply expired all end up at `auth.init()` or below; writing
 * `currentUser` directly in any of them is how one of those paths loses it.
 */
function setUser(next: unknown): void {
  const prevId = (currentUser as { id?: string } | null)?.id ?? null;
  const nextId = (next as { id?: string } | null)?.id ?? null;
  if (prevId !== nextId) clearApiCache();
  currentUser = next;
}

async function authPost(path: string, body: unknown) {
  const res = await api.fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Sign in failed');
  }
  return res.json();
}

/** A 200 without a user is not a sign-in; saying so beats a silent bounce off the guard. */
function setSignedIn(data: { user?: unknown }): void {
  if (!data?.user) throw new Error('Sign in failed');
  setUser(data.user);
}

export const auth = {
  get user() {
    return currentUser;
  },
  get loading() {
    return loading;
  },
  get isAuthenticated() {
    return !!currentUser;
  },

  async init() {
    try {
      const res = await api.fetch(`/api/me`);
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      loading = false;
    }
  },

  /**
   * Resolves `{ twoFactor: true }` when the account has TOTP on: Better Auth
   * then answers 200 `{ twoFactorRedirect }` with no session, only a short-lived
   * `two_factor` cookie, and the caller must finish with `verifySecondFactor`.
   * Reading that 200 as a sign-in sent the person to the admin guard, which
   * bounced them back to the sign-in form with no error, every time.
   */
  async signIn(email: string, password: string): Promise<{ twoFactor: boolean }> {
    const data = await authPost(`/api/auth/sign-in/email`, { email, password });
    if (data.twoFactorRedirect) return { twoFactor: true };
    setSignedIn(data);
    return { twoFactor: false };
  },

  /** Second sign-in step: six digits are an authenticator code, anything else a backup code. */
  async verifySecondFactor(code: string): Promise<void> {
    const trimmed = code.trim();
    const path = /^\d{6}$/.test(trimmed) ? 'verify-totp' : 'verify-backup-code';
    setSignedIn(await authPost(`/api/auth/two-factor/${path}`, { code: trimmed }));
  },

  async signOut() {
    await api.fetch(`/api/auth/sign-out`, {
      method: 'POST',
    });
    setUser(null);
  },
};
