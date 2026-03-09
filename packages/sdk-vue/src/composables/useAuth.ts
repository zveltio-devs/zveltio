import { ref, onMounted, type Ref } from 'vue';
import type { ZveltioClient } from '@zveltio/sdk';
import { inject } from 'vue';
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

  const fetchSession = async () => {
    try {
      const s = await client.auth.session();
      session.value = s;
      user.value = s?.user ?? null;
    } catch {
      session.value = null;
      user.value = null;
    } finally {
      loading.value = false;
    }
  };

  onMounted(fetchSession);

  const login = async (email: string, password: string) => {
    loading.value = true;
    error.value = null;
    try {
      await client.auth.login(email, password);
      await fetchSession();
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
      await client.auth.logout();
      user.value = null;
      session.value = null;
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
      await client.auth.signup(email, password, name);
      await fetchSession();
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      loading.value = false;
    }
  };

  return { user, session, loading, error, login, logout, signup };
}
