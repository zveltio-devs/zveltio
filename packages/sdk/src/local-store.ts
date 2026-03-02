import { openDB, type IDBPDatabase } from 'idb';

export interface LocalRecord {
  id: string;
  collection: string;
  data: Record<string, any>;
  _localVersion: number;     // Incrementat la fiecare write local
  _serverVersion: number;    // Versiunea confirmată de server
  _syncStatus: 'synced' | 'pending' | 'conflict';
  _updatedAt: number;        // timestamp ms
  _deletedAt?: number;       // soft delete pentru sync
}

export interface SyncQueueItem {
  id: string;               // auto-generated
  collection: string;
  recordId: string;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  attempts: number;
  createdAt: number;
  lastAttemptAt?: number;
  error?: string;
}

const DB_NAME = 'zveltio_local';
const DB_VERSION = 1;

export class LocalStore {
  private db: IDBPDatabase | null = null;

  async open(): Promise<void> {
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Store pentru date locale (mirror al colecțiilor server)
        if (!db.objectStoreNames.contains('records')) {
          const store = db.createObjectStore('records', { keyPath: ['collection', 'id'] });
          store.createIndex('by-collection', 'collection');
          store.createIndex('by-sync-status', '_syncStatus');
          store.createIndex('by-updated', '_updatedAt');
        }

        // Coadă de sincronizare (operații pending)
        if (!db.objectStoreNames.contains('sync_queue')) {
          const queue = db.createObjectStore('sync_queue', { keyPath: 'id' });
          queue.createIndex('by-collection', 'collection');
          queue.createIndex('by-created', 'createdAt');
        }

        // Metadata per colecție (last sync timestamp, etc.)
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      },
    });
  }

  /** Scrie un record local + adaugă în sync queue */
  async put(collection: string, id: string, data: Record<string, any>): Promise<LocalRecord> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = await this.db.get('records', [collection, id]) as LocalRecord | undefined;

    const record: LocalRecord = {
      id,
      collection,
      data,
      _localVersion: (existing?._localVersion || 0) + 1,
      _serverVersion: existing?._serverVersion || 0,
      _syncStatus: 'pending',
      _updatedAt: Date.now(),
    };

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // 1. Scrie record local
    await tx.objectStore('records').put(record);

    // 2. Adaugă în sync queue
    const queueItem: SyncQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      collection,
      recordId: id,
      operation: existing ? 'update' : 'create',
      payload: data,
      attempts: 0,
      createdAt: Date.now(),
    };
    await tx.objectStore('sync_queue').add(queueItem);

    await tx.done;
    return record;
  }

  /** Citește un record local (instant, fără network) */
  async get(collection: string, id: string): Promise<LocalRecord | undefined> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = await this.db.get('records', [collection, id]) as LocalRecord | undefined;
    if (record?._deletedAt) return undefined; // Soft-deleted
    return record;
  }

  /** Listează records dintr-o colecție (local) */
  async list(collection: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = await this.db.getAllFromIndex('records', 'by-collection', collection) as LocalRecord[];
    return all.filter((r) => !r._deletedAt);
  }

  /** Soft delete local + adaugă în sync queue */
  async delete(collection: string, id: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    const existing = await tx.objectStore('records').get([collection, id]) as LocalRecord | undefined;
    if (existing) {
      existing._deletedAt = Date.now();
      existing._syncStatus = 'pending';
      await tx.objectStore('records').put(existing);
    }

    const queueItem: SyncQueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      collection,
      recordId: id,
      operation: 'delete',
      payload: {},
      attempts: 0,
      createdAt: Date.now(),
    };
    await tx.objectStore('sync_queue').add(queueItem);

    await tx.done;
  }

  /** Returnează toate operațiile pending din sync queue */
  async getPendingOps(): Promise<SyncQueueItem[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    return this.db.getAllFromIndex('sync_queue', 'by-created') as Promise<SyncQueueItem[]>;
  }

  /** Marchează o operație ca finalizată (remove din queue, update record status) */
  async markSynced(queueItemId: string, collection: string, recordId: string, serverVersion: number): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // Remove din queue
    await tx.objectStore('sync_queue').delete(queueItemId);

    // Update record status
    const record = await tx.objectStore('records').get([collection, recordId]) as LocalRecord | undefined;
    if (record) {
      record._serverVersion = serverVersion;
      record._syncStatus = 'synced';
      await tx.objectStore('records').put(record);
    }

    await tx.done;
  }

  /** Marchează o operație ca failed (increment attempts, save error) */
  async markFailed(queueItemId: string, error: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const item = await this.db.get('sync_queue', queueItemId) as SyncQueueItem | undefined;
    if (item) {
      item.attempts += 1;
      item.lastAttemptAt = Date.now();
      item.error = error;
      await this.db.put('sync_queue', item);
    }
  }

  /** Aplică date venite de la server (prin WebSocket sau pull) */
  async applyServerUpdate(collection: string, id: string, data: Record<string, any>, serverVersion: number): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = await this.db.get('records', [collection, id]) as LocalRecord | undefined;

    // Conflict detection: dacă avem modificări locale nesincronizate
    if (existing && existing._syncStatus === 'pending') {
      // Last-write-wins default — serverul câștigă
      // Dar marcăm ca conflict pentru eventualul custom merge
      existing.data = data;
      existing._serverVersion = serverVersion;
      existing._syncStatus = 'conflict';
      await this.db.put('records', existing);
      return;
    }

    const record: LocalRecord = {
      id,
      collection,
      data,
      _localVersion: existing?._localVersion || 0,
      _serverVersion: serverVersion,
      _syncStatus: 'synced',
      _updatedAt: Date.now(),
    };

    await this.db.put('records', record);
  }

  /** Obține records cu conflicte pentru UI resolution */
  async getConflicts(collection?: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = await this.db.getAllFromIndex('records', 'by-sync-status', 'conflict') as LocalRecord[];
    if (collection) return all.filter((r) => r.collection === collection);
    return all;
  }

  /** Rezolvă un conflict (user decide care versiune câștigă) */
  async resolveConflict(collection: string, id: string, resolvedData: Record<string, any>): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = await this.db.get('records', [collection, id]) as LocalRecord | undefined;
    if (record) {
      record.data = resolvedData;
      record._syncStatus = 'pending'; // Re-sync cu serverul
      record._localVersion += 1;
      await this.db.put('records', record);
    }
  }

  /** Curăță toate datele locale */
  async clear(): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const tx = this.db.transaction(['records', 'sync_queue', 'meta'], 'readwrite');
    await tx.objectStore('records').clear();
    await tx.objectStore('sync_queue').clear();
    await tx.objectStore('meta').clear();
    await tx.done;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
