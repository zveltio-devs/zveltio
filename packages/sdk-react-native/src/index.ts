export { ZveltioProvider, useZveltioClient } from './context.js';
export type { ZveltioProviderProps } from './context.js';

export { useAuth } from './hooks/useAuth.js';
export { useCollection } from './hooks/useCollection.js';
export { useRecord } from './hooks/useRecord.js';
export { useRealtime } from './hooks/useRealtime.js';
export { useStorage } from './hooks/useStorage.js';

export type { HookResult, SyncStatus, CollectionOptions } from './types.js';
export type { AuthState } from './hooks/useAuth.js';
export type { StorageFile } from '@zveltio/sdk';

// Re-export core client
export { ZveltioClient, createZveltioClient } from '@zveltio/sdk';
