import { useState, useEffect, useRef } from 'react';
import { SyncManager } from '@zveltio/sdk';
import type { HookResult } from '../types.js';
import { useZveltioClient } from '../context.js';

export interface UseSyncCollectionOptions {
  realtimeUrl?: string;
  syncInterval?: number;
}

export function useSyncCollection<T = any>(
  collectionName: string,
  options?: UseSyncCollectionOptions,
): HookResult<T[]> {
  const client = useZveltioClient();
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const syncRef = useRef<SyncManager | null>(null);

  useEffect(() => {
    const sync = new SyncManager(client, {
      syncInterval: options?.syncInterval,
    });
    syncRef.current = sync;

    sync.start(options?.realtimeUrl).then(() => {
      const unsub = sync.collection(collectionName).subscribe((records) => {
        setData(records as T[]);
        setLoading(false);
      });
      return unsub;
    }).catch((err) => {
      setError(err instanceof Error ? err : new Error(String(err)));
      setLoading(false);
    });

    return () => {
      sync.stop();
      syncRef.current = null;
    };
  }, [client, collectionName]);

  return { data, loading, error };
}
