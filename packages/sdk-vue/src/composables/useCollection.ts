import { ref, onMounted, watch, toValue, type MaybeRefOrGetter, type Ref } from 'vue';
import { inject } from 'vue';
import { fetchCollection, type CollectionOptions } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function useCollection<T = any>(
  collectionName: string,
  // A ref or getter re-fetches when the options change, as `@zveltio/react`'s
  // `useCollection` does; a plain object is read once.
  options?: MaybeRefOrGetter<CollectionOptions | undefined>,
): {
  data: Ref<T[] | null>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
  refetch: () => Promise<void>;
} {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useCollection must be used within ZveltioPlugin');

  const data = ref<T[] | null>(null) as Ref<T[] | null>;
  const loading = ref(true);
  const error = ref<Error | null>(null);

  const load = async () => {
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetchCollection<T>(client, collectionName, toValue(options));
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loading.value = false;
    }
  };

  onMounted(load);
  watch(() => JSON.stringify(toValue(options)), load);

  return { data, loading, error, refetch: load };
}
