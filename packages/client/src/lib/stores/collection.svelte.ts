import { sync } from '$lib/zveltio';

/**
 * Reactive collection store — offline-first via SyncManager.
 *
 * Citirile sunt INSTANT (din IndexedDB local).
 * Scrierile se fac local + se sincronizeaza async cu serverul.
 *
 * Exemplu:
 * ```svelte
 * <script>
 *   import { useCollection } from '$stores/collection.svelte';
 *   const tasks = useCollection('tasks');
 * </script>
 * {#each tasks.data as task}
 *   <div>{task.title} — {task._syncStatus}</div>
 * {/each}
 * ```
 */

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export function useCollection<T extends Record<string, any> = Record<string, any>>(
  collectionName: string,
) {
  let data = $state<(T & { id: string; _syncStatus?: string })[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const coll = sync.collection(collectionName);

  $effect(() => {
    let unsubscribe: (() => void) | undefined;

    // 1. Citire initiala din IndexedDB (instant)
    coll
      .list()
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      .then((records: any[]) => {
        // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
        data = records as any;
        loading = false;
      })
      .catch((err: Error) => {
        error = err.message;
        loading = false;
      });

    // 2. Subscribe la updates (realtime + local writes)
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    unsubscribe = coll.subscribe((records: any[]) => {
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      data = records as any;
    });

    return () => unsubscribe?.();
  });

  return {
    get data() {
      return data;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },

    async create(payload: Omit<T, 'id'>) {
      return coll.create(payload);
    },

    async update(id: string, payload: Partial<T>) {
      return coll.update(id, payload);
    },

    async remove(id: string) {
      return coll.delete(id);
    },
  };
}
