// One definition, the SDK's: `fetchCollection` is what these options reach.
export type { CollectionOptions } from '@zveltio/sdk';

export interface SyncStatus {
  status: 'online' | 'offline' | 'syncing';
  pendingCount: number;
}
