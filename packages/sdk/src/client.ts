export interface ZveltioClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface ListParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  filter?: Record<string, any>;
  cursor?: string;
}

export interface ListResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  next_cursor?: string;
}

class CollectionRef<T extends Record<string, any>> {
  constructor(
    private readonly name: string,
    private readonly client: ZveltioClient<any>,
  ) {}

  list(params?: ListParams): Promise<ListResult<T>> {
    const qs = new URLSearchParams();
    if (params?.page) qs.set('page', String(params.page));
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.sort) qs.set('sort', params.sort);
    if (params?.order) qs.set('order', params.order);
    if (params?.search) qs.set('search', params.search);
    if (params?.filter) qs.set('filter', JSON.stringify(params.filter));
    if (params?.cursor) qs.set('cursor', params.cursor);
    const q = qs.toString();
    return this.client['request']('GET', `/api/data/${this.name}${q ? `?${q}` : ''}`);
  }

  getMany(params?: ListParams): Promise<ListResult<T>> {
    return this.list(params);
  }

  getOne(id: string): Promise<T> {
    return this.client['request']('GET', `/api/data/${this.name}/${id}`);
  }

  create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T> {
    return this.client['request']('POST', `/api/data/${this.name}`, data);
  }

  update(id: string, data: Partial<Omit<T, 'id' | 'created_at' | 'updated_at'>>): Promise<T> {
    return this.client['request']('PATCH', `/api/data/${this.name}/${id}`, data);
  }

  delete(id: string): Promise<{ success: boolean }> {
    return this.client['request']('DELETE', `/api/data/${this.name}/${id}`);
  }
}

/**
 * ZveltioClient — generic over your schema type.
 *
 * Usage with generated types (run `zveltio generate-types` once):
 *
 *   import type { ZveltioSchema } from './zveltio-types';
 *   const client = createZveltioClient<ZveltioSchema>({ baseUrl: '...' });
 *   const { data } = await client.collection('products').list();
 *   //          ^-- typed as your Products interface
 *
 * Usage without types (untyped, same as before):
 *   const client = createZveltioClient({ baseUrl: '...' });
 */
export class ZveltioClient<Schema extends Record<string, any> = Record<string, any>> {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: ZveltioClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'X-API-Key': config.apiKey } : {}),
      ...config.headers,
    };
  }

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  get<T = any>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T = any>(path: string, body?: unknown): Promise<T> { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body?: unknown): Promise<T> { return this.request<T>('PATCH', path, body); }
  delete<T = any>(path: string): Promise<T> { return this.request<T>('DELETE', path); }

  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const headers = { ...this.headers };
    delete headers['Content-Type'];
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers, credentials: 'include', body: formData,
    });
    if (!res.ok) throw new Error(`Upload ${path} failed: ${res.status}`);
    return res.json();
  }

  /**
   * Returns a fully-typed collection reference.
   * If Schema is provided (via createZveltioClient<MySchema>()),
   * the return type reflects the collection's record shape.
   */
  collection<K extends keyof Schema & string>(name: K): CollectionRef<Schema[K]>;
  collection(name: string): CollectionRef<Record<string, any>>;
  collection(name: string): CollectionRef<any> {
    return new CollectionRef(name, this);
  }

  /** Auth helpers */
  readonly auth = {
    login: (email: string, password: string) =>
      this.request('POST', '/api/auth/sign-in/email', { email, password }),
    signup: (email: string, password: string, name: string) =>
      this.request('POST', '/api/auth/sign-up/email', { email, password, name }),
    logout: () => this.request('POST', '/api/auth/sign-out'),
    session: () => this.request('GET', '/api/auth/get-session'),
  } as const;

  /** Storage helpers */
  readonly storage = {
    upload: (file: File, folder?: string) => {
      const fd = new FormData();
      fd.append('file', file);
      if (folder) fd.append('folder', folder);
      return this.upload('/api/storage/upload', fd);
    },
    list: (folder?: string) => this.get(`/api/storage${folder ? `?folder=${folder}` : ''}`),
    delete: (key: string) => this.delete(`/api/storage/${encodeURIComponent(key)}`),
  } as const;
}

export function createZveltioClient<Schema extends Record<string, any> = Record<string, any>>(
  config: ZveltioClientConfig,
): ZveltioClient<Schema> {
  return new ZveltioClient<Schema>(config);
}
