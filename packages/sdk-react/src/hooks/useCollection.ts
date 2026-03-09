import { useState, useEffect, useCallback } from 'react';
import type { HookResult, CollectionOptions } from '../types.js';
import { useZveltioClient } from '../context.js';

export function useCollection<T = any>(
  collectionName: string,
  options?: CollectionOptions,
): HookResult<T[]> & { refetch: () => void } {
  const client = useZveltioClient();
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.collection(collectionName).list(options);
      setData(result?.data ?? result ?? []);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client, collectionName, JSON.stringify(options)]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
