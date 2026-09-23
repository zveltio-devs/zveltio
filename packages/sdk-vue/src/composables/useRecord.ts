import { ref, onMounted, watch, toValue, type MaybeRefOrGetter, type Ref } from 'vue';
import { inject } from 'vue';
import { fetchRecord } from '@zveltio/sdk';
import type { ZveltioClient } from '@zveltio/sdk';
import { ZVELTIO_CLIENT_KEY } from '../plugin.js';

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
export function useRecord<T = any>(
  collectionName: string,
  // A plain string cannot change after setup; pass a ref or getter to follow
  // a route param the way `@zveltio/react`'s `useRecord` follows its prop.
  id: MaybeRefOrGetter<string | null | undefined>,
): {
  data: Ref<T | null>;
  loading: Ref<boolean>;
  error: Ref<Error | null>;
  refetch: () => Promise<void>;
} {
  const client = inject<ZveltioClient>(ZVELTIO_CLIENT_KEY);
  if (!client) throw new Error('useRecord must be used within ZveltioPlugin');

  const data = ref<T | null>(null) as Ref<T | null>;
  const loading = ref(!!toValue(id));
  const error = ref<Error | null>(null);

  const load = async () => {
    const current = toValue(id);
    if (!current) {
      data.value = null;
      loading.value = false;
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      data.value = await fetchRecord<T>(client, collectionName, current);
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      loading.value = false;
    }
  };

  onMounted(load);
  watch(() => toValue(id), load);

  return { data, loading, error, refetch: load };
}
