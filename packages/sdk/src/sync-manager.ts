import type { ZveltioClient } from './client.js';
import type { ZveltioRealtime } from './realtime.js';
import { LocalStore } from './local-store.js';

export interface SyncManagerConfig {
  /** Interval de sync în ms (default: 5000) */
  syncInterval?: number;
  /** Max retry attempts per operație (default: 5) */
  maxRetries?: number;
  /** Exponential backoff base în ms (default: 1000) */
  backoffBase?: number;
  /** Callback pentru conflicte (default: server-wins) */
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
        this.syncNow(); // Sync imediat la reconectare
      });
      window.addEventListener('offline', () => { this.isOnline = false; });
      this.isOnline = navigator.onLine;
    }

    // Realtime: primește push updates de la server
    if (realtimeUrl) {
      const { ZveltioRealtime } = await import('./realtime.js');
      this.realtime = new ZveltioRealtime(realtimeUrl);
      this.realtime.connect();
      // Subscribe-uri se fac per colecție prin collection()
    }

    // Periodic sync
    this.syncTimer = setInterval(() => this.syncNow(), this.config.syncInterval);

    // Sync inițial
    await this.syncNow();
  }

  /**
   * Returnează un collection proxy local-first:
   * - list/get citesc LOCAL (instant)
   * - create/update/delete scriu LOCAL + queue sync
   * - subscribe primește updates în realtime
   */
  collection(name: string) {
    return {
      /** List records — citește LOCAL instant */
      list: async () => {
        const records = await this.store.list(name);
        return records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus }));
      },

      /** Get one record — citește LOCAL instant */
      get: async (id: string) => {
        const record = await this.store.get(name, id);
        if (!record) return null;
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Create — scrie LOCAL + queue sync */
      create: async (data: Record<string, any>) => {
        const id = data.id || crypto.randomUUID();
        const record = await this.store.put(name, id, data);
        this.notifyListeners(name);
        this.syncNow(); // Trigger sync imediat (non-blocking)
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Update — scrie LOCAL + queue sync */
      update: async (id: string, data: Record<string, any>) => {
        const existing = await this.store.get(name, id);
        const merged = { ...(existing?.data || {}), ...data };
        const record = await this.store.put(name, id, merged);
        this.notifyListeners(name);
        this.syncNow();
        return { id: record.id, ...record.data, _syncStatus: record._syncStatus };
      },

      /** Delete — soft delete LOCAL + queue sync */
      delete: async (id: string) => {
        await this.store.delete(name, id);
        this.notifyListeners(name);
        this.syncNow();
      },

      /** Subscribe la changes (realtime + local writes) */
      subscribe: (callback: (records: any[]) => void) => {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)!.add(callback);

        // Subscribe la realtime server push
        let unsubRealtime: (() => void) | undefined;
        if (this.realtime) {
          unsubRealtime = this.realtime.subscribe(name, async (event) => {
            // Aplică update de la server în local store
            if (event.event === 'record.created' || event.event === 'record.updated') {
              try {
                const serverRecord = await this.client.collection(name).get(event.record_id);
                await this.store.applyServerUpdate(name, event.record_id, serverRecord, Date.now());
                this.notifyListeners(name);
              } catch { /* offline sau eroare — ignoră, sync-ul periodic va rezolva */ }
            } else if (event.event === 'record.deleted') {
              await this.store.delete(name, event.record_id);
              this.notifyListeners(name);
            }
          });
        }

        // Emit starea curentă imediat
        this.store.list(name).then((records) => {
          callback(records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus })));
        });

        // Return unsubscribe function
        return () => {
          this.listeners.get(name)?.delete(callback);
          unsubRealtime?.();
        };
      },

      /** Obține conflicte pending pentru UI resolution */
      getConflicts: async () => {
        return this.store.getConflicts(name);
      },

      /** Rezolvă un conflict manual */
      resolveConflict: async (id: string, resolvedData: Record<string, any>) => {
        await this.store.resolveConflict(name, id, resolvedData);
        this.notifyListeners(name);
        this.syncNow();
      },
    };
  }

  /** Force sync acum (non-blocking) */
  async syncNow(): Promise<void> {
    if (!this.isOnline || this.isSyncing) return;
    this.isSyncing = true;

    try {
      // Pasul 1: Uploadează blob-urile offline ÎNAINTE de sync records
      const pendingBlobs = await this.store.getPendingBlobs();
      for (const blobItem of pendingBlobs) {
        try {
          const file = new File([blobItem.blob], `offline_${blobItem.id}`, { type: blobItem.blob.type });
          const result = await this.client.storage.upload(file) as any;
          const url: string = result?.url || result?.publicUrl || result?.path || '';
          if (!url) continue; // Upload a returnat fără URL — skip

          // Înlocuiește referința local_blob_* cu URL-ul real în record
          const record = await this.store.get(blobItem.collection, blobItem.recordId);
          if (record && record.data[blobItem.field] === blobItem.id) {
            await this.store.put(blobItem.collection, blobItem.recordId, {
              ...record.data,
              [blobItem.field]: url,
            });
          }

          await this.store.deleteBlob(blobItem.id);
        } catch {
          // Offline sau eroare de upload — skip, retry la next sync cycle
        }
      }

      const pending = await this.store.getPendingOps();

      for (const op of pending) {
        if (op.attempts >= this.config.maxRetries) continue; // Skip operații epuizate

        try {
          const serverVersion = Date.now();

          switch (op.operation) {
            case 'create':
              await this.client.collection(op.collection).create({ id: op.recordId, ...op.payload });
              break;
            case 'update':
              await this.client.collection(op.collection).update(op.recordId, op.payload);
              break;
            case 'delete':
              await this.client.collection(op.collection).delete(op.recordId);
              break;
          }

          await this.store.markSynced(op.id, op.collection, op.recordId, serverVersion);
          this.notifyListeners(op.collection);
        } catch (err: any) {
          // Conflict de la server (409) — aplică conflict resolution
          if (err.message?.includes('409')) {
            try {
              const serverRecord = await this.client.collection(op.collection).get(op.recordId);
              const localRecord = await this.store.get(op.collection, op.recordId);
              const resolved = this.config.onConflict(localRecord?.data, serverRecord);
              await this.store.resolveConflict(op.collection, op.recordId, resolved);
            } catch { /* fallback: server wins — ignoră eroarea */ }
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
    const mapped = records.map((r) => ({ id: r.id, ...r.data, _syncStatus: r._syncStatus }));
    callbacks.forEach((cb) => {
      try { cb(mapped); } catch { /* ignore callback errors */ }
    });
  }

  /** Status: câte operații pending, câte conflicte */
  async getStatus(): Promise<{ pending: number; conflicts: number; isOnline: boolean }> {
    const pending = await this.store.getPendingOps();
    const conflicts = await this.store.getConflicts();
    return { pending: pending.length, conflicts: conflicts.length, isOnline: this.isOnline };
  }

  async stop(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.realtime?.disconnect();
    await this.store.close();
  }
}
