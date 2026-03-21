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
  filter?: Record<string, any>;
  search?: string;
}

export interface QueryResponse<T = any> {
  records: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface SingleResponse<T = any> {
  record: T;
}

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
  data: any;
  timestamp: string;
}
