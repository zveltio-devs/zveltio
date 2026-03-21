import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import type { SyncManager } from '@zveltio/sdk';
import type { SyncStatus } from '../types.js';

export function useSyncStatus(
  syncManager?: SyncManager,
  pollIntervalMs = 2000,
): { status: Ref<SyncStatus> } {
  const status = ref<SyncStatus>({ status: 'online', pendingCount: 0 });
  let timer: ReturnType<typeof setInterval> | null = null;

  const updateOnline = () => {
    if (typeof navigator !== 'undefined') {
      status.value = {
        ...status.value,
        status: navigator.onLine ? 'online' : 'offline',
      };
    }
  };

  onMounted(() => {
    if (!syncManager) {
      if (typeof window !== 'undefined') {
        window.addEventListener('online', updateOnline);
        window.addEventListener('offline', updateOnline);
        updateOnline();
      }
      return;
    }

    const poll = async () => {
      try {
        const s = await syncManager.getStatus();
        status.value = {
          status: s.isOnline ? (s.pending > 0 ? 'syncing' : 'online') : 'offline',
          pendingCount: s.pending,
        };
      } catch {
        /* ignore */
      }
    };

    poll();
    timer = setInterval(poll, pollIntervalMs);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    }
  });

  return { status };
}
