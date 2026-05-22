import { api } from './api.js';

let currentUser = $state<any>(null);
let loading = $state(true);

export const auth = {
  get user() { return currentUser; },
  get loading() { return loading; },
  get isAuthenticated() { return !!currentUser; },

  async init() {
    try {
      const res = await api.fetch(`/api/me`);
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
      } else {
        currentUser = null;
      }
    } catch {
      currentUser = null;
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
    currentUser = data.user;
    return data;
  },

  async signOut() {
    await api.fetch(`/api/auth/sign-out`, {
      method: 'POST',
    });
    currentUser = null;
  },
};
