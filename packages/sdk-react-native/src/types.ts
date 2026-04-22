export interface HookResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface SyncStatus {
  syncing: boolean;
  lastSyncedAt: Date | null;
  error: Error | null;
}

export type { CollectionOptions } from '@zveltio/sdk';
