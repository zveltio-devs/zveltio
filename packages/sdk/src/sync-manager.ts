import type { ZveltioClient } from './client.js';
import type { ZveltioRealtime } from './realtime.js';
import { LocalStore } from './local-store.js';

export interface SyncManagerConfig {
  /** Sync interval in ms (default: 5000) */
  syncInterval?: number;
  /** Max retry attempts per operation (default: 5) */
  maxRetries?: number;
  /** Exponential backoff base in ms (default: 1000) */
  backoffBase?: number;
  /** Callback for conflicts (default: server-wins) */
  onConflict?: (local: any, server: any) => any;
}

export class SyncManager {
  private store: LocalStore;
  private client: ZveltioClient;
  private realtime: ZveltioRealtime | null = null;
  private config: Required<SyncManagerConfig>;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isOnline: boolean = true;
  private isSyncing: boolean = false;
  private listeners: Map<string, Set<(records: any[]) => void>> = new Map();

  constructor(client: ZveltioClient, config: SyncManagerConfig = {}) {
    this.store = new LocalStore();
    this.client = client;
    this.config = {
      syncInterval: config.syncInterval ?? 5000,
      maxRetries: config.maxRetries ?? 5,
      backoffBase: config.backoffBase ?? 1000,
      onConflict: config.onConflict ?? ((_local, server) => server), // Server wins default
    };
  }

  async start(realtimeUrl?: string): Promise<void> {
    await this.store.open();

    // Online/offline detection
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        this.syncNow(); // Sync immediately on reconnect
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
      });
      this.isOnline = navigator.onLine;
    }

    // Realtime: receives push updates from server
    if (realtimeUrl) {
      const { ZveltioRealtime } = await import('./realtime.js');
      this.realtime = new ZveltioRealtime(realtimeUrl);
      this.realtime.connect();
      // Subscriptions are per-collection via collection()
    }

    // Periodic sync
    this.syncTimer = setInterval(
      () => this.syncNow(),
      this.config.syncInterval,
    );

    // Initial sync
    await this.syncNow();
  }

  /**
   * Returns a local-first collection proxy:
   * - list/get reads LOCAL (instant)
   * - create/update/delete writes LOCAL + queues sync
   * - subscribe receives realtime updates
   */
  collection(name: string) {
    return {
      /** List records — reads LOCAL instantly */
      list: async () => {
        const records = await this.store.list(name);
        return records.map((r) => ({
          id: r.id,
          ...r.data,
          _syncStatus: r._syncStatus,
        }));
      },

      /** Get one record — reads LOCAL instantly */
      get: async (id: string) => {
        const record = await this.store.get(name, id);
        if (!record) return null;
        return {
          id: record.id,
          ...record.data,
          _syncStatus: record._syncStatus,
        };
      },

      /** Create — writes LOCAL + queues sync */
      create: async (data: Record<string, any>) => {
        const id = data.id || crypto.randomUUID();
        const record = await this.store.put(name, id, data);
        this.notifyListeners(name);
        this.syncNow(); // Trigger sync immediately (non-blocking)
        return {
          id: record.id,
          ...record.data,
          _syncStatus: record._syncStatus,
        };
      },

      /** Update — writes LOCAL + queues sync */
      update: async (id: string, data: Record<string, any>) => {
        const existing = await this.store.get(name, id);
        const merged = { ...(existing?.data || {}), ...data };
        const record = await this.store.put(name, id, merged);
        this.notifyListeners(name);
        this.syncNow();
        return {
          id: record.id,
          ...record.data,
          _syncStatus: record._syncStatus,
        };
      },

      /** Delete — soft delete LOCAL + queues sync */
      delete: async (id: string) => {
        await this.store.delete(name, id);
        this.notifyListeners(name);
        this.syncNow();
      },

      /** Subscribe la changes (realtime + local writes) */
      subscribe: (callback: (records: any[]) => void) => {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)!.add(callback);

        // Subscribe to realtime server push
        let unsubRealtime: (() => void) | undefined;
        if (this.realtime) {
          unsubRealtime = this.realtime.subscribe(name, async (event) => {
            // Apply update from server to local store
            if (
              event.event === 'record.created' ||
              event.event === 'record.updated'
            ) {
              try {
                const serverRecord = await this.client
                  .collection(name)
                  .get(event.record_id);
                await this.store.applyServerUpdate(
                  name,
                  event.record_id,
                  serverRecord,
                  Date.now(),
                );
                this.notifyListeners(name);
              } catch {
                /* offline or error — ignore, periodic sync will resolve */
              }
            } else if (event.event === 'record.deleted') {
              await this.store.delete(name, event.record_id);
              this.notifyListeners(name);
            }
          });
        }

        // Emit current state immediately
        this.store.list(name).then((records) => {
          callback(
            records.map((r) => ({
              id: r.id,
              ...r.data,
              _syncStatus: r._syncStatus,
            })),
          );
        });

        // Return unsubscribe function
        return () => {
          this.listeners.get(name)?.delete(callback);
          unsubRealtime?.();
        };
      },

      /** Get pending conflicts for UI resolution */
      getConflicts: async () => {
        return this.store.getConflicts(name);
      },

      /** Resolve a conflict manually */
      resolveConflict: async (
        id: string,
        resolvedData: Record<string, any>,
      ) => {
        await this.store.resolveConflict(name, id, resolvedData);
        this.notifyListeners(name);
        this.syncNow();
      },
    };
  }

  /** Force sync now (non-blocking) */
  async syncNow(): Promise<void> {
    if (!this.isOnline || this.isSyncing) return;
    this.isSyncing = true;

    try {
      // Step 1: Upload offline blobs BEFORE syncing records
      const pendingBlobs = await this.store.getPendingBlobs();
      for (const blobItem of pendingBlobs) {
        try {
          const file = new File([blobItem.blob], `offline_${blobItem.id}`, {
            type: blobItem.blob.type,
          });
          const result = (await this.client.storage.upload(file)) as any;
          const url: string =
            result?.url || result?.publicUrl || result?.path || '';
          if (!url) continue; // Upload returned without URL — skip

          // Replace local_blob_* reference with real URL in record
          const record = await this.store.get(
            blobItem.collection,
            blobItem.recordId,
          );
          if (record && record.data[blobItem.field] === blobItem.id) {
            await this.store.put(blobItem.collection, blobItem.recordId, {
              ...record.data,
              [blobItem.field]: url,
            });
          }

          await this.store.deleteBlob(blobItem.id);
        } catch {
          // Offline or upload error — skip, retry at next sync cycle
        }
      }

      const pending = await this.store.getPendingOps();

      for (const op of pending) {
        if (op.attempts >= this.config.maxRetries) continue; // Skip exhausted operations

        try {
          const serverVersion = Date.now();

          switch (op.operation) {
            case 'create':
              await this.client
                .collection(op.collection)
                .create({ id: op.recordId, ...op.payload });
              break;
            case 'update':
              await this.client
                .collection(op.collection)
                .update(op.recordId, op.payload);
              break;
            case 'delete':
              await this.client.collection(op.collection).delete(op.recordId);
              break;
          }

          await this.store.markSynced(
            op.id,
            op.collection,
            op.recordId,
            serverVersion,
          );
          this.notifyListeners(op.collection);
        } catch (err: any) {
          // Conflict from server (409) — apply conflict resolution
          if (err.message?.includes('409')) {
            try {
              const serverRecord = await this.client
                .collection(op.collection)
                .get(op.recordId);
              const localRecord = await this.store.get(
                op.collection,
                op.recordId,
              );
              const resolved = this.config.onConflict(
                localRecord?.data,
                serverRecord,
              );
              await this.store.resolveConflict(
                op.collection,
                op.recordId,
                resolved,
              );
            } catch {
              /* fallback: server wins — ignore error */
            }
          } else {
            // Exponential backoff
            await this.store.markFailed(op.id, err.message || 'Unknown error');
          }
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async notifyListeners(collection: string): Promise<void> {
    const callbacks = this.listeners.get(collection);
    if (!callbacks?.size) return;

    const records = await this.store.list(collection);
    const mapped = records.map((r) => ({
      id: r.id,
      ...r.data,
      _syncStatus: r._syncStatus,
    }));
    callbacks.forEach((cb) => {
      try {
        cb(mapped);
      } catch {
        /* ignore callback errors */
      }
    });
  }

  /** Status: pending operations count, conflicts count */
  async getStatus(): Promise<{
    pending: number;
    conflicts: number;
    isOnline: boolean;
  }> {
    const pending = await this.store.getPendingOps();
    const conflicts = await this.store.getConflicts();
    return {
      pending: pending.length,
      conflicts: conflicts.length,
      isOnline: this.isOnline,
    };
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.realtime?.disconnect();
    await this.store.close();
  }
}
