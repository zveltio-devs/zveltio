import { createAuthClient } from 'better-auth/svelte';

const ENGINE_URL = import.meta.env.PUBLIC_ENGINE_URL || 'http://localhost:3000';

export const authClient = createAuthClient({
  baseURL: ENGINE_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;
