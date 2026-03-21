/**
 * Svelte 5 runes integration with SyncManager.
 *
 * Usage in Svelte 5 components:
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
 * Subscribe to a collection via SyncManager.
 * Calls `setter` immediately with current state and on each update.
 * Returns the unsubscribe function.
 */
export function useSyncCollection(
  sync: SyncManager,
  collection: string,
  setter: (records: any[]) => void,
): () => void {
  const col = sync.collection(collection);
  return col.subscribe(setter);
}

/**
 * Subscribe to sync status (pending, conflicts, isOnline).
 * Calls `setter` immediately and on each sync cycle.
 * Returns the cleanup function.
 */
export function useSyncStatus(
  sync: SyncManager,
  setter: (status: {
    pending: number;
    conflicts: number;
    isOnline: boolean;
  }) => void,
  intervalMs = 2000,
): () => void {
  // Emit immediately
  sync.getStatus().then(setter);

  // Periodic poll (SyncManager doesn't have event system for status)
  const timer = setInterval(() => {
    sync
      .getStatus()
      .then(setter)
      .catch(() => {
        /* ignore */
      });
  }, intervalMs);

  return () => clearInterval(timer);
}
