export { ZveltioClient, createZveltioClient } from './client.js';
export type { ZveltioClientConfig, ListParams, ListResult } from './client.js';
export { ZveltioRealtime } from './realtime.js';
export { LocalStore } from './local-store.js';
export { SyncManager } from './sync-manager.js';
export type { ZveltioExtension, ExtensionContext, FieldTypeRegistryAPI, StudioExtensionAPI, StudioRoute, StudioFieldType, AssetPreviewHandler } from './extension/index.js';
export type { LocalRecord, SyncQueueItem } from './local-store.js';
export type { SyncManagerConfig } from './sync-manager.js';
export { useSyncCollection, useSyncStatus } from './svelte.js';
export * from './crdt.js';
export * from './core.js';

// Schema watcher (for dev mode type generation)
export { watchSchema, generateTypes } from './schema-watcher.js';
export type { CollectionSchema, CollectionField, WatchSchemaOptions } from './schema-watcher.js';
