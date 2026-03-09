export { ZveltioPlugin, ZVELTIO_CLIENT_KEY } from './plugin.js';
export type { ZveltioPluginOptions } from './plugin.js';

export { useCollection } from './composables/useCollection.js';
export { useRecord } from './composables/useRecord.js';
export { useSyncCollection } from './composables/useSyncCollection.js';
export type { UseSyncCollectionOptions } from './composables/useSyncCollection.js';
export { useSyncStatus } from './composables/useSyncStatus.js';
export { useRealtime } from './composables/useRealtime.js';
export { useAuth } from './composables/useAuth.js';
export { useStorage } from './composables/useStorage.js';

export type { CollectionOptions, SyncStatus } from './types.js';

// Re-export core client for convenience
export { ZveltioClient, createZveltioClient } from '@zveltio/sdk';
