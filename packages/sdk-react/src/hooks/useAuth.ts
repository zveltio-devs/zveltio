import { useState, useEffect, useCallback } from 'react';
import { fetchSession, loginUser, logoutUser, signupUser, type AuthState } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';
import type { HookResult } from '../types.js';

export type { AuthState };

export function useAuth(): HookResult<AuthState> & {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (email: string, password: string, name: string) => Promise<void>;
} {
  const client = useZveltioClient();
  const [data, setData] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setData(await fetchSession(client));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { loadSession(); }, [loadSession]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await loginUser(client, email, password));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  const logout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await logoutUser(client));
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
      setData(await signupUser(client, email, password, name));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  return { data, loading, error, login, logout, signup };
}
