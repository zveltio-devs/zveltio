import type { ZveltioConfig, QueryOptions, QueryResponse, SingleResponse, CreateResponse, DeleteResponse } from '../types/index.js';
import { QueryBuilder } from './QueryBuilder.js';
import { Auth } from './Auth.js';
import { RealtimeClient } from './RealtimeClient.js';

export class ZveltioClient {
  readonly auth: Auth;
  readonly realtime: RealtimeClient;
  private config: ZveltioConfig;

  constructor(config: ZveltioConfig) {
    this.config = config;
    this.auth = new Auth(config);
    this.realtime = new RealtimeClient(config.baseUrl);
  }

  // Fluent query builder
  from(collection: string): QueryBuilder {
    return new QueryBuilder(collection, this.config);
  }

  // Direct CRUD methods
  async list<T = any>(collection: string, options?: QueryOptions): Promise<QueryResponse<T>> {
    return this.from(collection).query<T>(options);
  }

  async get<T = any>(collection: string, id: string): Promise<T> {
    const res = await this.request<SingleResponse<T>>(`/api/data/${collection}/${id}`);
    return res.record;
  }

  async create<T = any>(collection: string, data: Partial<T>): Promise<T> {
    const res = await this.request<CreateResponse<T>>(`/api/data/${collection}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return res.record;
  }

  async update<T = any>(collection: string, id: string, data: Partial<T>): Promise<T> {
    const res = await this.request<SingleResponse<T>>(`/api/data/${collection}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    return res.record;
  }

  async replace<T = any>(collection: string, id: string, data: T): Promise<T> {
    const res = await this.request<SingleResponse<T>>(`/api/data/${collection}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return res.record;
  }

  async delete(collection: string, id: string): Promise<DeleteResponse> {
    return this.request<DeleteResponse>(`/api/data/${collection}/${id}`, {
      method: 'DELETE',
    });
  }

  // Raw request helper
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string>),
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    const res = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });

    if (res.status === 401) {
      this.config.onUnauthorized?.();
      throw new Error('Unauthorized');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Request failed: ${res.status}`);
    }

    return res.json() as Promise<T>;
  }
}

export function createClient(config: ZveltioConfig): ZveltioClient {
  return new ZveltioClient(config);
}
