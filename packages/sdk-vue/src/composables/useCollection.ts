import { ref, onMounted, watch, type Ref } from 'vue';
import type { ZveltioClient } from '@zveltio/sdk';
import { inject } from 'vue';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';
import type { CollectionOptions } from '../types.js';

export function useCollection<T = any>(
  collectionName: string,
  options?: CollectionOptions,
): { data: Ref<T[] | null>; loading: Ref<boolean>; error: Ref<Error | null>; refetch: () => Promise<void> } {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useCollection must be used within ZveltioPlugin');

  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const fetch = async () => {
    loading.value = true;
    error.value = null;
    try {
      const result = await client.collection(collectionName).list(options);
      data.value = result?.data ?? result ?? [];
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loading.value = false;
    }
  };

  onMounted(fetch);

  return { data, loading, error, refetch: fetch };
}
