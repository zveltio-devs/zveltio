import { useState, useEffect, useCallback } from 'react';
import { fetchCollection, type CollectionOptions } from '@zveltio/sdk';
import { useZveltioClient } from '../context.js';
import type { HookResult } from '../types.js';

export function useCollection<T = any>(
  collectionName: string,
  options?: CollectionOptions,
): HookResult<T[]> & { refetch: () => void } {
  const client = useZveltioClient();
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchCollection<T>(client, collectionName, options));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client, collectionName, JSON.stringify(options)]);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, refetch: load };
}
