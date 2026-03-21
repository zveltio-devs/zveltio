import type { ZveltioConfig } from '../types/index.js';

export class Auth {
  private config: ZveltioConfig;

  constructor(config: ZveltioConfig) {
    this.config = config;
  }

  async signIn(email: string, password: string): Promise<{ user: any; session: any }> {
    const res = await fetch(`${this.config.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error((await res.json()).message || 'Sign in failed');
    return res.json();
  }

  async signUp(name: string, email: string, password: string): Promise<{ user: any }> {
    const res = await fetch(`${this.config.baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    });
    if (!res.ok) throw new Error((await res.json()).message || 'Sign up failed');
    return res.json();
  }

  async signOut(): Promise<void> {
    await fetch(`${this.config.baseUrl}/api/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });
  }

  async getSession(): Promise<{ user: any; session: any } | null> {
    const res = await fetch(`${this.config.baseUrl}/api/me`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    return { user: data.user, session: {} };
  }

  // OAuth redirect
  signInWithOAuth(provider: 'google' | 'github' | 'microsoft'): void {
    window.location.href = `${this.config.baseUrl}/api/auth/sign-in/${provider}`;
  }
}
