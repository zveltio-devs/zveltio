import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import type { ZveltioClient } from '@zveltio/sdk';
import { SyncManager } from '@zveltio/sdk';
import { inject } from 'vue';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export interface UseSyncCollectionOptions {
  realtimeUrl?: string;
  syncInterval?: number;
}

export function useSyncCollection<T = any>(
  collectionName: string,
  options?: UseSyncCollectionOptions,
): { data: Ref<T[] | null>; loading: Ref<boolean>; error: Ref<Error | null> } {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useSyncCollection must be used within ZveltioPlugin');

  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const loading = ref(true);
  const error = ref<Error | null>(null);

  let sync: SyncManager | null = null;
  let unsub: (() => void) | null = null;

  onMounted(async () => {
    sync = new SyncManager(client, { syncInterval: options?.syncInterval });
    try {
      await sync.start(options?.realtimeUrl);
      unsub = sync.collection(collectionName).subscribe((records) => {
        data.value = records as T[];
        loading.value = false;
      });
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      loading.value = false;
    }
  });

  onUnmounted(() => {
    unsub?.();
    sync?.stop();
    sync = null;
  });

  return { data, loading, error };
}
