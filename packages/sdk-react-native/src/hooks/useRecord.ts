import { useState, useEffect, useCallback } from 'react';
import { fetchRecord } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';
import type { HookResult } from '../types.js';

export function useRecord<T = any>(
  collectionName: string,
  id: string | null,
): HookResult<T> & { refetch: () => void } {
  const client = useZveltioClient();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!id) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await fetchRecord<T>(client, collectionName, id));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client, collectionName, id]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, refetch: load };
}
