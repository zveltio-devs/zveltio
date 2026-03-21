import type { Database } from '../../../../packages/engine/src/db/index.js';
import { SearchManager } from './search-manager.js';

export function startSyncWorker(db: Database, eventBus: any): void {
  SearchManager.init(db);

  eventBus.on('record.created', async (payload: { collection: string; record: Record<string, unknown> }) => {
    try {
      await SearchManager.index(payload.collection, payload.record);
    } catch (err) {
      console.error('[SearchSyncWorker] Failed to index record.created:', err);
    }
  });

  eventBus.on('record.updated', async (payload: { collection: string; record: Record<string, unknown> }) => {
    try {
      await SearchManager.index(payload.collection, payload.record);
    } catch (err) {
      console.error('[SearchSyncWorker] Failed to index record.updated:', err);
    }
  });

  eventBus.on('record.deleted', async (payload: { collection: string; id: string }) => {
    try {
      await SearchManager.remove(payload.collection, payload.id);
    } catch (err) {
      console.error('[SearchSyncWorker] Failed to remove record.deleted:', err);
    }
  });

  console.log('[SearchSyncWorker] Listening for record events');
}
