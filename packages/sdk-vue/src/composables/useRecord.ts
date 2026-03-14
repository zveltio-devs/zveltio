import { ref, onMounted, watch, type Ref } from 'vue';
import { inject } from 'vue';
import { fetchRecord } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

export function useRecord<T = any>(
  collectionName: string,
  id: string | null | undefined,
): { data: Ref<T | null>; loading: Ref<boolean>; error: Ref<Error | null>; refetch: () => Promise<void> } {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useRecord must be used within ZveltioPlugin');

  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(!!id);
  const error = ref<Error | null>(null);

  const load = async () => {
    if (!id) { data.value = null; loading.value = false; return; }
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetchRecord<T>(client, collectionName, id);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loading.value = false;
    }
  };

  onMounted(load);
  watch(() => id, load);

  return { data, loading, error, refetch: load };
}
