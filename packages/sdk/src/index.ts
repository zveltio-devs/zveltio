export { ZveltioClient, createZveltioClient } from './client.js';
export { ZveltioRealtime } from './realtime.js';
export { LocalStore } from './local-store.js';
export { SyncManager } from './sync-manager.js';
export type { ZveltioClientConfig } from './client.js';
export type { ZveltioExtension } from './extension/index.js';
export type { LocalRecord, SyncQueueItem } from './local-store.js';
export type { SyncManagerConfig } from './sync-manager.js';
export { useSyncCollection, useSyncStatus } from './svelte.js';
export * from './crdt.js';

// Framework-agnostic core logic (used by sdk-react and sdk-vue)
export * from './core.js';
