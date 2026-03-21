export interface CollectionOptions {
  filter?: Record<string, any>;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  page?: number;
  search?: string;
}

export interface HookResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface SyncStatus {
  status: 'online' | 'offline' | 'syncing';
  pendingCount: number;
}
