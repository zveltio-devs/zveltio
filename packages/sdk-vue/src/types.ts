export interface CollectionOptions {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
