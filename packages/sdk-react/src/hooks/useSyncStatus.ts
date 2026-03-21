import { useState, useEffect, useRef } from 'react';
import { SyncManager } from '@zveltio/sdk';
import type { SyncStatus } from '../types.js';
import { useZveltioClient } from '../context.js';

export function useSyncStatus(
  syncManager?: SyncManager,
  pollIntervalMs = 2000,
): SyncStatus {
  const client = useZveltioClient();
  const [status, setStatus] = useState<SyncStatus>({
    status: 'online',
    pendingCount: 0,
  });

  // If no syncManager passed in, use the client's online state via navigator
  useEffect(() => {
    if (!syncManager) {
      const updateOnline = () =>
        setStatus((s) => ({
          ...s,
          status: (typeof navigator !== 'undefined' && !navigator.onLine)
            ? 'offline'
            : 'online',
        }));

      if (typeof window !== 'undefined') {
        window.addEventListener('online', updateOnline);
        window.addEventListener('offline', updateOnline);
        updateOnline();
      }
      return () => {
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', updateOnline);
          window.removeEventListener('offline', updateOnline);
        }
      };
    }

    const poll = async () => {
      try {
        const s = await syncManager.getStatus();
        setStatus({
          status: s.isOnline ? (s.pending > 0 ? 'syncing' : 'online') : 'offline',
          pendingCount: s.pending,
        });
      } catch {
        /* ignore */
      }
    };

    poll();
    const timer = setInterval(poll, pollIntervalMs);
    return () => clearInterval(timer);
  }, [syncManager, pollIntervalMs]);

  return status;
}
