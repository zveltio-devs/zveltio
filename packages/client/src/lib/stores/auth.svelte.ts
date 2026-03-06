import { authClient, useSession } from '$lib/auth-client';
import { goto } from '$app/navigation';

/**
 * Reactive auth store cu Svelte 5 rune.
 * Foloseste better-auth/svelte useSession() intern.
 */
export function useAuth() {
  const session = useSession();

  return {
    get user() { return session.data?.user ?? null; },
    get isLoggedIn() { return !!session.data?.user; },
    get isPending() { return session.isPending; },

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
      await authClient.signOut();
      await goto('/auth/login');
    },

    async resetPassword(email: string) {
      return authClient.forgetPassword({ email, redirectTo: '/auth/reset-password' });
    },
  };
}
