import { useState, useEffect, useCallback } from 'react';
import type { HookResult } from '../types.js';
import { useZveltioClient } from '../context.js';

export interface AuthState {
  user: any | null;
  session: any | null;
}

export function useAuth(): HookResult<AuthState> & {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
} {
  const client = useZveltioClient();
  const [data, setData] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchSession = useCallback(async () => {
    try {
      const session = await client.auth.session();
      setData({ user: session?.user ?? null, session });
    } catch {
      setData({ user: null, session: null });
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      await client.auth.login(email, password);
      await fetchSession();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client, fetchSession]);

  const logout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await client.auth.logout();
      setData({ user: null, session: null });
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  const signup = useCallback(async (email: string, password: string, name: string) => {
    setLoading(true);
    setError(null);
    try {
      await client.auth.signup(email, password, name);
      await fetchSession();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client, fetchSession]);

  return { data, loading, error, login, logout, signup };
}
