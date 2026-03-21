import { ref, onMounted, type Ref } from 'vue';
import { inject } from 'vue';
import { fetchSession, loginUser, logoutUser, signupUser } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export function useAuth(): {
  user: Ref<any | null>;
  session: Ref<any | null>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
} {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useAuth must be used within ZveltioPlugin');

  const user = ref<any | null>(null);
  const session = ref<any | null>(null);
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const loadSession = async () => {
    try {
      const state = await fetchSession(client);
      session.value = state.session;
      user.value = state.user;
    } finally {
      loading.value = false;
    }
  };

  onMounted(loadSession);

  const login = async (email: string, password: string) => {
    loading.value = true;
    error.value = null;
    try {
      const state = await loginUser(client, email, password);
      user.value = state.user;
      session.value = state.session;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      loading.value = false;
    }
  };

  const logout = async () => {
    loading.value = true;
    error.value = null;
    try {
      const state = await logoutUser(client);
      user.value = state.user;
      session.value = state.session;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      loading.value = false;
    }
  };

  const signup = async (email: string, password: string, name: string) => {
    loading.value = true;
    error.value = null;
    try {
      const state = await signupUser(client, email, password, name);
      user.value = state.user;
      session.value = state.session;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      loading.value = false;
    }
  };

  return { user, session, loading, error, login, logout, signup };
}
