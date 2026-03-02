export interface ZveltioClientConfig {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export class ZveltioClient {
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

  get<T = any>(path: string) { return this.request<T>('GET', path); }
  post<T = any>(path: string, body?: unknown) { return this.request<T>('POST', path, body); }
  patch<T = any>(path: string, body?: unknown) { return this.request<T>('PATCH', path, body); }
  delete<T = any>(path: string) { return this.request<T>('DELETE', path); }

  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const headers = { ...this.headers };
    delete headers['Content-Type']; // Browser sets multipart boundary
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers, credentials: 'include', body: formData,
    });
    if (!res.ok) throw new Error(`Upload ${path} failed: ${res.status}`);
    return res.json();
  }

  /** Collection CRUD helper */
  collection(name: string) {
    return {
      list: (params?: { page?: number; limit?: number; sort?: string; order?: string; search?: string; filter?: Record<string, any> }) => {
        const qs = new URLSearchParams();
        if (params?.page) qs.set('page', String(params.page));
        if (params?.limit) qs.set('limit', String(params.limit));
        if (params?.sort) qs.set('sort', params.sort);
        if (params?.order) qs.set('order', params.order);
        if (params?.search) qs.set('search', params.search);
        if (params?.filter) qs.set('filter', JSON.stringify(params.filter));
        const query = qs.toString();
        return this.get(`/api/data/${name}${query ? `?${query}` : ''}`);
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
    list: (folder?: string) => this.get(`/api/storage${folder ? `?folder=${folder}` : ''}`),
    delete: (key: string) => this.delete(`/api/storage/${encodeURIComponent(key)}`),
  };
}

export function createZveltioClient(config: ZveltioClientConfig): ZveltioClient {
  return new ZveltioClient(config);
}
