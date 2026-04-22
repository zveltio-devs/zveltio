import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchSession, loginUser, logoutUser, signupUser, type AuthState } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';
import type { HookResult } from '../types.js';

// React Native: persist session token via AsyncStorage (optional peer dep)
let AsyncStorage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> } | null = null;
// Dynamic require works in React Native bundlers (Metro/Expo); falls back gracefully if absent
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = (globalThis as any).require?.('@react-native-async-storage/async-storage');
  if (mod) AsyncStorage = mod.default ?? mod;
} catch { /* optional peer dep */ }

const SESSION_KEY = '@zveltio/session_token';

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
      const session = await fetchSession(client);
      setData(session);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { loadSession(); }, [loadSession]);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const session = await loginUser(client, email, password);
      setData(session);
      // Persist token for React Native (no cookies)
      if (AsyncStorage && (session as any)?.token) {
        await AsyncStorage.setItem(SESSION_KEY, (session as any).token);
      }
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
      if (AsyncStorage) await AsyncStorage.removeItem(SESSION_KEY);
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
      const session = await signupUser(client, email, password, name);
      setData(session);
      if (AsyncStorage && (session as any)?.token) {
        await AsyncStorage.setItem(SESSION_KEY, (session as any).token);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client]);

  return { data, loading, error, login, logout, signup };
}
