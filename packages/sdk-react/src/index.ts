export { ZveltioProvider, useZveltioClient } from './context.js';
export { useCollection } from './hooks/useCollection.js';
export { useRecord } from './hooks/useRecord.js';
export { useSyncCollection } from './hooks/useSyncCollection.js';
export { useSyncStatus } from './hooks/useSyncStatus.js';
export { useRealtime } from './hooks/useRealtime.js';
export { useAuth } from './hooks/useAuth.js';
export { useStorage } from './hooks/useStorage.js';

export type { CollectionOptions, HookResult, SyncStatus } from './types.js';
export type { ZveltioProviderProps } from './context.js';
export type { UseSyncCollectionOptions } from './hooks/useSyncCollection.js';
export type { AuthState } from './hooks/useAuth.js';
export type { StorageFile } from '@zveltio/sdk';

// Re-export core client for convenience
export { ZveltioClient, createZveltioClient } from '@zveltio/sdk';
