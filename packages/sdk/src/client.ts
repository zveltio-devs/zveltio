export interface ZveltioClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class ZveltioHttpClient {
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

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers, credentials: 'include' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async post<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: this.headers, credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }

  async patch<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH', headers: this.headers, credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status}`);
    return res.json();
  }

  async delete<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE', headers: this.headers, credentials: 'include',
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
    return res.json();
  }

  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const { 'Content-Type': _, ...uploadHeaders } = this.headers;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: uploadHeaders, credentials: 'include', body: formData,
    });
    if (!res.ok) throw new Error(`Upload ${path} failed: ${res.status}`);
    return res.json();
  }

  /** Fluent collection accessor */
  collection(name: string) {
    return {
      list: (params?: {
        page?: number;
        limit?: number;
        sort?: string;
        order?: string;
        search?: string;
        filter?: Record<string, any>;
      }) => {
        const qs = new URLSearchParams();
        if (params?.page) qs.set('page', String(params.page));
        if (params?.limit) qs.set('limit', String(params.limit));
        if (params?.sort) qs.set('sort', params.sort);
        if (params?.order) qs.set('order', params.order);
        if (params?.search) qs.set('search', params.search);
        if (params?.filter) qs.set('filter', JSON.stringify(params.filter));
        const q = qs.toString();
        return this.get(`/api/data/${name}${q ? '?' + q : ''}`);
      },
      get: (id: string) => this.get(`/api/data/${name}/${id}`),
      create: (data: Record<string, any>) => this.post(`/api/data/${name}`, data),
      update: (id: string, data: Record<string, any>) => this.patch(`/api/data/${name}/${id}`, data),
      delete: (id: string) => this.delete(`/api/data/${name}/${id}`),
    };
  }

  /** Auth helpers */
  auth = {
    login: (email: string, password: string) =>
      this.post('/api/auth/sign-in/email', { email, password }),
    signup: (email: string, password: string, name: string) =>
      this.post('/api/auth/sign-up/email', { email, password, name }),
    logout: () => this.post('/api/auth/sign-out'),
    session: () => this.get('/api/auth/get-session'),
  };

  /** Storage helpers */
  storage = {
    upload: (file: File, folder?: string) => {
      const fd = new FormData();
      fd.append('file', file);
      if (folder) fd.append('folder', folder);
      return this.upload('/api/storage/upload', fd);
    },
    list: (folder?: string) => this.get(`/api/storage${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`),
    delete: (key: string) => this.delete(`/api/storage/${encodeURIComponent(key)}`),
  };
}

export function createZveltioClient(config: ZveltioClientConfig): ZveltioHttpClient {
  return new ZveltioHttpClient(config);
}
