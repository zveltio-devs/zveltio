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

  async signIn(email: string, password: string) {
    const res = await api.fetch(`/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'Sign in failed');
    }

    const data = await res.json();
    setUser(data.user);
    return data;
  },

  async signOut() {
    await api.fetch(`/api/auth/sign-out`, {
      method: 'POST',
    });
    setUser(null);
  },
};
