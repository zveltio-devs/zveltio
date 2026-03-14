import { ref, onMounted, type Ref } from 'vue';
import { inject } from 'vue';
import { fetchCollection, type CollectionOptions } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export function useCollection<T = any>(
  collectionName: string,
  options?: CollectionOptions,
): { data: Ref<T[] | null>; loading: Ref<boolean>; error: Ref<Error | null>; refetch: () => Promise<void> } {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useCollection must be used within ZveltioPlugin');

  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const load = async () => {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetchCollection<T>(client, collectionName, options);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loading.value = false;
    }
  };

  onMounted(load);

  return { data, loading, error, refetch: load };
}
