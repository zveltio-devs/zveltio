export interface ZveltioConfig {
  baseUrl: string;
  apiKey?: string;
  onUnauthorized?: () => void;
}

export interface QueryOptions {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  filter?: Record<string, any>;
  search?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface QueryResponse<T = any> {
  records: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface SingleResponse<T = any> {
  record: T;
}

// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
export interface CreateResponse<T = any> {
  record: T;
}

export interface DeleteResponse {
  success: boolean;
  id: string;
}

export interface RealtimeMessage {
  event: 'insert' | 'update' | 'delete';
  collection: string;
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  data: any;
  timestamp: string;
}
