/**
 * Svelte 5 runes integration cu SyncManager.
 *
 * Folosire în componente Svelte 5:
 *
 * ```svelte
 * <script lang="ts">
 *   import { SyncManager } from '@zveltio/sdk';
 *   import { useSyncCollection, useSyncStatus } from '@zveltio/sdk/svelte';
 *
 *   let todos = $state<any[]>([]);
 *   const unsub = useSyncCollection(sync, 'todos', (records) => { todos = records; });
 *
 *   let status = $state({ pending: 0, conflicts: 0, isOnline: true });
 *   const unsubStatus = useSyncStatus(sync, (s) => { status = s; });
 *
 *   onDestroy(() => { unsub(); unsubStatus(); });
 * </script>
 * ```
 */

import type { SyncManager } from './sync-manager.js';

/**
 * Subscribe la o colecție prin SyncManager.
 * Apelează `setter` imediat cu starea curentă și la fiecare update.
 * Returnează funcția de unsubscribe.
 */
export function useSyncCollection(
  sync: SyncManager,
  collection: string,
  setter: (records: any[]) => void
): () => void {
  const col = sync.collection(collection);
  return col.subscribe(setter);
}

/**
 * Subscribe la statusul sync (pending, conflicts, isOnline).
 * Apelează `setter` imediat și la fiecare sync ciclu.
 * Returnează funcția de cleanup.
 */
export function useSyncStatus(
  sync: SyncManager,
  setter: (status: { pending: number; conflicts: number; isOnline: boolean }) => void,
  intervalMs = 2000
): () => void {
  // Emit imediat
  sync.getStatus().then(setter);

  // Poll periodic (SyncManager nu are event system pentru status)
  const timer = setInterval(() => {
    sync.getStatus().then(setter).catch(() => { /* ignore */ });
  }, intervalMs);

  return () => clearInterval(timer);
}
