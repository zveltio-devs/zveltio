import { openDB, type IDBPDatabase } from 'idb';
import { LamportClock, mergeLWW, toDocument, fromDocument, type LWWDocument } from './crdt.js';

export interface LocalRecord {
  id: string;
  collection: string;
  data: Record<string, any>;
  _localVersion: number; // Incremented on every local write
  _serverVersion: number; // Confirmed version from server
  _syncStatus: 'synced' | 'pending' | 'conflict';
  _updatedAt: number; // timestamp ms
  _deletedAt?: number; // soft delete for sync
  _conflictData?: Record<string, any>; // server data at conflict time, for UI resolution
  _crdtDoc?: LWWDocument; // CRDT field-level version vector (optional)
}

export interface SyncQueueItem {
  id: string; // auto-generated
  collection: string;
  recordId: string;
  operation: 'create' | 'update' | 'delete';
  payload: Record<string, any>;
  attempts: number;
  createdAt: number;
  lastAttemptAt?: number;
  error?: string;
}

export interface OfflineBlob {
  id: string; // 'local_blob_<UUID>'
  blob: Blob;
  collection: string;
  recordId: string;
  field: string; // the field in the record that references the blob
  createdAt: number;
}

const DB_NAME = 'zveltio_local';
const DB_VERSION = 3; // v3: CRDT Lamport clock in meta store

export class LocalStore {
  private db: IDBPDatabase | null = null;
  private clock: LamportClock | null = null;

  async open(): Promise<void> {
    this.db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db: IDBPDatabase, oldVersion: number) {
        if (oldVersion < 1) {
          // Store for local data (mirror of server collections)
          const store = db.createObjectStore('records', {
            keyPath: ['collection', 'id'],
          });
          store.createIndex('by-collection', 'collection');
          store.createIndex('by-sync-status', '_syncStatus');
          store.createIndex('by-updated', '_updatedAt');

          // Sync queue (pending operations)
          const queue = db.createObjectStore('sync_queue', { keyPath: 'id' });
          queue.createIndex('by-collection', 'collection');
          queue.createIndex('by-created', 'createdAt');

          // Metadata per collection (last sync timestamp, etc.)
          db.createObjectStore('meta', { keyPath: 'key' });
        }

        if (oldVersion < 2) {
          // Blobs saved offline — upload on first reconnect
          db.createObjectStore('offline_blobs', { keyPath: 'id' });
        }
        // v3: no new stores — Lamport clock stored as key in existing 'meta' store
      },
    });

    // Initialize CRDT Lamport clock (persisted in meta store)
    let clientId = (await this.db.get('meta', 'crdt_client_id'))?.value as string | undefined;
    if (!clientId) {
      clientId = crypto.randomUUID();
      await this.db.put('meta', { key: 'crdt_client_id', value: clientId });
    }
    const storedLamport = ((await this.db.get('meta', 'crdt_lamport'))?.value as number) ?? 0;
    this.clock = new LamportClock(clientId, storedLamport);
  }

  private async persistLamport(): Promise<void> {
    if (!this.db || !this.clock) return;
    await this.db.put('meta', { key: 'crdt_lamport', value: this.clock.current });
  }

  /** Write a local record and add to sync queue */
  async put(
    collection: string,
    id: string,
    data: Record<string, any>,
  ): Promise<LocalRecord> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = (await this.db.get('records', [collection, id])) as
      | LocalRecord
      | undefined;

    const lamport = this.clock ? this.clock.tick() : Date.now();
    const clientId = this.clock?.id ?? 'unknown';
    const crdtDoc = toDocument(data, lamport, clientId);

    const record: LocalRecord = {
      id,
      collection,
      data,
      _localVersion: (existing?._localVersion || 0) + 1,
      _serverVersion: existing?._serverVersion || 0,
      _syncStatus: 'pending',
      _updatedAt: Date.now(),
      _crdtDoc: crdtDoc,
    };

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // 1. Write local record
    await tx.objectStore('records').put(record);

    // 2. Add to sync queue
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
    await this.persistLamport();
    return record;
  }

  /** Read a local record (instant, no network) */
  async get(collection: string, id: string): Promise<LocalRecord | undefined> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = (await this.db.get('records', [collection, id])) as
      | LocalRecord
      | undefined;
    if (record?._deletedAt) return undefined; // Soft-deleted
    return record;
  }

  /** List records from a collection (local) */
  async list(collection: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = (await this.db.getAllFromIndex(
      'records',
      'by-collection',
      collection,
    )) as LocalRecord[];
    return all.filter((r) => !r._deletedAt);
  }

  /** Soft delete local and add to sync queue */
  async delete(collection: string, id: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    const existing = (await tx.objectStore('records').get([collection, id])) as
      | LocalRecord
      | undefined;
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

  /** Returns all pending operations from sync queue */
  async getPendingOps(): Promise<SyncQueueItem[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    return this.db.getAllFromIndex('sync_queue', 'by-created') as Promise<
      SyncQueueItem[]
    >;
  }

  /** Mark an operation as completed (remove from queue, update record status) */
  async markSynced(
    queueItemId: string,
    collection: string,
    recordId: string,
    serverVersion: number,
  ): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const tx = this.db.transaction(['records', 'sync_queue'], 'readwrite');

    // Remove from queue
    await tx.objectStore('sync_queue').delete(queueItemId);

    // Update record status
    const record = (await tx
      .objectStore('records')
      .get([collection, recordId])) as LocalRecord | undefined;
    if (record) {
      record._serverVersion = serverVersion;
      record._syncStatus = 'synced';
      await tx.objectStore('records').put(record);
    }

    await tx.done;
  }

  /** Mark an operation as failed (increment attempts, save error) */
  async markFailed(queueItemId: string, error: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const item = (await this.db.get('sync_queue', queueItemId)) as
      | SyncQueueItem
      | undefined;
    if (item) {
      item.attempts += 1;
      item.lastAttemptAt = Date.now();
      item.error = error;
      await this.db.put('sync_queue', item);
    }
  }

  /** Apply data from server (via WebSocket or pull) */
  async applyServerUpdate(
    collection: string,
    id: string,
    data: Record<string, any>,
    serverVersion: number,
  ): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');

    const existing = (await this.db.get('records', [collection, id])) as
      | LocalRecord
      | undefined;

    // Conflict detection: local has changes not yet confirmed by server
    if (existing && existing._localVersion > existing._serverVersion) {
      // CRDT field-level merge if both sides have CRDT docs
      if (existing._crdtDoc && (data as any).__crdt) {
        const remoteCrdtDoc = (data as any).__crdt as LWWDocument;
        const merged = mergeLWW(existing._crdtDoc, remoteCrdtDoc);
        const mergedData = fromDocument(merged);
        if (this.clock) {
          this.clock.update(Math.max(...Object.values(merged).map((f) => f.lamport)));
          await this.persistLamport();
        }
        existing.data = mergedData;
        existing._crdtDoc = merged;
        existing._serverVersion = serverVersion;
        existing._syncStatus = 'synced'; // CRDT merge resolved without conflict
        await this.db.put('records', existing);
        return;
      }
      // No CRDT doc — mark as conflict for manual resolution
      existing._conflictData = data;
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

  /** Get records with conflicts for UI resolution */
  async getConflicts(collection?: string): Promise<LocalRecord[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    const all = (await this.db.getAllFromIndex(
      'records',
      'by-sync-status',
      'conflict',
    )) as LocalRecord[];
    if (collection) return all.filter((r) => r.collection === collection);
    return all;
  }

  /** Resolve a conflict (user decides which version wins) */
  async resolveConflict(
    collection: string,
    id: string,
    resolvedData: Record<string, any>,
  ): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const record = (await this.db.get('records', [collection, id])) as
      | LocalRecord
      | undefined;
    if (record) {
      record.data = resolvedData;
      record._syncStatus = 'pending'; // Re-sync with server
      record._localVersion += 1;
      await this.db.put('records', record);
    }
  }

  /** Save an offline blob — returns a temporary ID 'local_blob_<UUID>' */
  async saveBlob(
    blob: Blob,
    collection: string,
    recordId: string,
    field: string,
  ): Promise<string> {
    if (!this.db) throw new Error('LocalStore not opened');
    const id = `local_blob_${crypto.randomUUID()}`;
    const item: OfflineBlob = {
      id,
      blob,
      collection,
      recordId,
      field,
      createdAt: Date.now(),
    };
    await this.db.put('offline_blobs', item);
    return id;
  }

  /** Returns all pending offline blobs */
  async getPendingBlobs(): Promise<OfflineBlob[]> {
    if (!this.db) throw new Error('LocalStore not opened');
    return this.db.getAll('offline_blobs') as Promise<OfflineBlob[]>;
  }

  /** Delete an offline blob after successful upload */
  async deleteBlob(id: string): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    await this.db.delete('offline_blobs', id);
  }

  /** Clear all local data */
  async clear(): Promise<void> {
    if (!this.db) throw new Error('LocalStore not opened');
    const tx = this.db.transaction(
      ['records', 'sync_queue', 'meta', 'offline_blobs'],
      'readwrite',
    );
    await tx.objectStore('records').clear();
    await tx.objectStore('sync_queue').clear();
    await tx.objectStore('meta').clear();
    await tx.objectStore('offline_blobs').clear();
    await tx.done;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
