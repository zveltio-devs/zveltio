import { useState, useEffect, useRef } from 'react';
import { SyncManager } from '@zveltio/sdk';
import type { HookResult } from '../types.js';
import { useZveltioClient } from '../context.js';

export interface UseSyncCollectionOptions {
  realtimeUrl?: string;
  syncInterval?: number;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
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
    let unsub: (() => void) | undefined;
    let cancelled = false;

    sync
      .start(options?.realtimeUrl)
      .then(() => {
        if (cancelled) return;
        unsub = sync.collection(collectionName).subscribe((records) => {
          setData(records as T[]);
          setLoading(false);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      unsub?.();
      sync.stop();
      syncRef.current = null;
    };
  }, [client, collectionName, options?.realtimeUrl, options?.syncInterval]);

  return { data, loading, error };
}
