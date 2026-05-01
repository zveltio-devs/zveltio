import { ENGINE_URL } from './config.js';

class ApiClient {
  private base: string;

  constructor(base: string) {
    this.base = base;
  }

  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Request failed: ${res.status}`);
    }

    return res.json();
  }

  get<T>(path: string) { return this.request<T>('GET', path); }
  post<T>(path: string, body?: any) { return this.request<T>('POST', path, body); }
  put<T>(path: string, body: any) { return this.request<T>('PUT', path, body); }
  patch<T>(path: string, body: any) { return this.request<T>('PATCH', path, body); }
  delete<T>(path: string, body?: any) { return this.request<T>('DELETE', path, body); }
}

export const api = new ApiClient(ENGINE_URL);

// Short-lived in-memory cache to prevent duplicate requests when switching tabs.
// collections/list and field-types rarely change — 30s TTL is safe.
interface CacheEntry<T> { data: T; expiresAt: number }
const _cache = new Map<string, CacheEntry<any>>();
const TTL = 30_000;

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  return fn().then((data) => {
    _cache.set(key, { data, expiresAt: Date.now() + TTL });
    return data;
  });
}

export function invalidateCollectionsCache() {
  _cache.delete('collections:list');
  _cache.delete('collections:field-types');
}

// Typed helpers
export const collectionsApi = {
  list: () => cached('collections:list', () => api.get<{ collections: any[] }>('/api/collections')),
  get: (name: string) => api.get<{ collection: any }>(`/api/collections/${name}`),
  create: (data: any) => api.post<{ collection: any; job_id: string }>('/api/collections', data).then((r) => { invalidateCollectionsCache(); return r; }),
  delete: (name: string) => api.delete(`/api/collections/${name}`).then((r) => { invalidateCollectionsCache(); return r; }),
  fieldTypes: () => cached('collections:field-types', () => api.get<{ field_types: any[] }>('/api/collections/field-types')),
  jobStatus: (jobId: string) => api.get<{ job: any }>(`/api/collections/jobs/${jobId}`),
};

export const dataApi = {
  list: (collection: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return api.get<{ records: any[]; pagination: any }>(`/api/data/${collection}${qs}`);
  },
  // Note: GET/POST/PATCH return the record directly (no { record: ... } wrapper)
  get: (collection: string, id: string) =>
    api.get<any>(`/api/data/${collection}/${id}`),
  create: (collection: string, data: any) =>
    api.post<any>(`/api/data/${collection}`, data),
  update: (collection: string, id: string, data: any) =>
    api.patch<any>(`/api/data/${collection}/${id}`, data),
  delete: (collection: string, id: string) =>
    api.delete(`/api/data/${collection}/${id}`),
  bulkDelete: (collection: string, ids: string[]) =>
    api.delete<{ deleted: number }>(`/api/data/${collection}/bulk`, { ids }),
};

export const usersApi = {
  list: async (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const data = await api.get<{ users: any[]; pagination: any }>(`/api/users${qs}`);
    return data.users || [];
  },
  get: (id: string) => api.get<{ user: any }>(`/api/users/${id}`),
  invite: (data: any) => api.post<{ user: any }>('/api/users/invite', data),
  update: (id: string, data: any) => api.patch<{ user: any }>(`/api/users/${id}`, data),
  delete: (id: string) => api.delete(`/api/users/${id}`),
};

export const settingsApi = {
  getAll: () => api.get<Record<string, any>>('/api/settings'),
  getPublic: () => api.get<Record<string, any>>('/api/settings/public'),
  update: (key: string, value: any) => api.put(`/api/settings/${key}`, { value }),
  updateBulk: (data: Record<string, any>) => api.patch('/api/settings/bulk', data),
};

export const webhooksApi = {
  list: async () => {
    const data = await api.get<{ webhooks: any[] }>('/api/webhooks');
    return data.webhooks || [];
  },
  get: (id: string) => api.get<{ webhook: any }>(`/api/webhooks/${id}`),
  create: (data: any) => api.post<{ webhook: any }>('/api/webhooks', data),
  update: (id: string, data: any) => api.patch<{ webhook: any }>(`/api/webhooks/${id}`, data),
  delete: (id: string) => api.delete(`/api/webhooks/${id}`),
  test: (id: string) => api.post(`/api/webhooks/${id}/test`),
  deliveries: (id: string) => api.get<{ deliveries: any[] }>(`/api/webhooks/${id}/deliveries`),
};

export const importApi = {
  jobs: () => api.get<{ jobs: any[] }>('/api/import/jobs'),
};

export const zonesApi = {
  list: () => api.get<{ zones: any[] }>('/api/zones'),
  create: (data: any) => api.post<{ zone: any }>('/api/zones', data),
  get: (slug: string) => api.get<{ zone: any }>(`/api/zones/${slug}`),
  update: (slug: string, data: any) => api.put<{ zone: any }>(`/api/zones/${slug}`, data),
  delete: (slug: string) => api.delete(`/api/zones/${slug}`),
  listPages: (slug: string) => api.get<{ pages: any[] }>(`/api/zones/${slug}/pages`),
  createPage: (slug: string, data: any) => api.post<{ page: any }>(`/api/zones/${slug}/pages`, data),
  updatePage: (slug: string, pageSlug: string, data: any) => api.put<{ page: any }>(`/api/zones/${slug}/pages/${pageSlug}`, data),
  deletePage: (slug: string, pageSlug: string) => api.delete(`/api/zones/${slug}/pages/${pageSlug}`),
  reorderPages: (slug: string, ids: string[]) => api.post(`/api/zones/${slug}/pages/reorder`, { ids }),
  render: (slug: string) => api.get<{ zone: any; pages: any[] }>(`/api/zones/${slug}/render`),
  renderPage: (slug: string, pageSlug: string) => api.get<{ page: any; zone: any; views: any[] }>(`/api/zones/${slug}/render/${pageSlug}`),
};

export const viewsApi = {
  list: () => api.get<{ views: any[] }>('/api/views'),
  create: (data: any) => api.post<{ view: any }>('/api/views', data),
  get: (id: string) => api.get<{ view: any }>(`/api/views/${id}`),
  update: (id: string, data: any) => api.put<{ view: any }>(`/api/views/${id}`, data),
  delete: (id: string) => api.delete(`/api/views/${id}`),
};
