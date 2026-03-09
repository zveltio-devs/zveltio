export interface CollectionOptions {
  filter?: Record<string, any>;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  page?: number;
  search?: string;
}

export interface SyncStatus {
  status: 'online' | 'offline' | 'syncing';
  pendingCount: number;
}
