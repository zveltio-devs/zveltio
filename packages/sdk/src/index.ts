export { ZveltioClient, createClient } from './client/ZveltioClient.js';
export { QueryBuilder } from './client/QueryBuilder.js';
export { RealtimeClient } from './client/RealtimeClient.js';
export { Auth } from './client/Auth.js';
export { watchSchema, generateTypes } from './schema-watcher.js';

// Simple HTTP client (config-based)
export { ZveltioHttpClient, createZveltioClient } from './client.js';
export type { ZveltioClientConfig } from './client.js';

// Realtime WebSocket client
export { ZveltioRealtime } from './realtime.js';

export type {
  ZveltioConfig,
  QueryOptions,
  QueryResponse,
  SingleResponse,
  CreateResponse,
  DeleteResponse,
} from './types/index.js';

export type {
  CollectionSchema as ZveltioCollectionSchema,
  CollectionField as ZveltioCollectionField,
  WatchSchemaOptions,
} from './schema-watcher.js';
