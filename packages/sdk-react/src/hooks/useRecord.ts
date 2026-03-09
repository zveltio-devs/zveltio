import { useState, useEffect, useCallback } from 'react';
import type { HookResult } from '../types.js';
import { useZveltioClient } from '../context.js';

export function useRecord<T = any>(
  collectionName: string,
  id: string | null | undefined,
): HookResult<T> & { refetch: () => void } {
  const client = useZveltioClient();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    if (!id) { setData(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await client.collection(collectionName).get(id);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [client, collectionName, id]);

  useEffect(() => { fetch(); }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
