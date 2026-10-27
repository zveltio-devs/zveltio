import { authClient, useSession } from '#lib/auth-client.js';
import { goto } from '$app/navigation';
import { sync } from '#lib/zveltio.js';

/**
 * Reactive auth store cu Svelte 5 rune.
 * Foloseste better-auth/svelte useSession() intern.
 */
export function useAuth() {
  const session = useSession();

  return {
    get user() {
      return session.get().data?.user ?? null;
    },
    get isLoggedIn() {
      return !!session.get().data?.user;
    },
    get isPending() {
      return session.get().isPending;
    },

    async signIn(email: string, password: string) {
      const result = await authClient.signIn.email({ email, password });
      if (!result.error) {
        await goto('/');
      }
      return result;
    },

    async signUp(data: { email: string; password: string; name: string }) {
      const result = await authClient.signUp.email(data);
      if (!result.error) {
        await goto('/auth/login?registered=true');
      }
      return result;
    },

    async signOut() {
      // Push what is pending while the session still exists, then forget it
      // all: the next user of this browser must not inherit it.
      await sync.syncNow().catch(() => {});
      await authClient.signOut();
      await sync.clearLocalData();
      await goto('/auth/login');
    },

    async resetPassword(email: string) {
      return authClient.requestPasswordReset({ email, redirectTo: '/auth/reset-password' });
    },
  };
}
