import { ENGINE_URL } from './config.js';

class ApiClient {
  private base: string;

  constructor(base: string) {
    this.base = base;
  }

  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  private async request<T>(method: string, path: string, body?: any): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // Unified error envelope (H-13): prefer problem+json `detail`/`title`,
      // keep tolerant fallback for legacy `{ error }` bodies during the beta.
      const err = await res.json().catch(() => ({}));
      const message =
        err.detail || err.title || err.error || err.message || `Request failed: ${res.status}`;
      const e = new Error(message) as Error & {
        code?: string;
        status?: number;
        traceId?: string;
        resource?: string;
        confidential?: boolean;
        canGrant?: Array<{ name: string }>;
      };
      e.code = err.code;
      e.status = res.status;
      e.traceId = err.traceId;
      // A refusal carries what the person needs to act: which resource, whether
      // it is confidential, and who can grant it. `detail` above is the
      // engine's English fallback for logs and curl; the UI renders these
      // fields translated (see `denialMessage`).
      if (err.code === 'permission_required') {
        e.resource = err.resource;
        e.confidential = err.confidential;
        e.canGrant = Array.isArray(err.can_grant) ? err.can_grant : [];
      }
      throw e;
    }

    return res.json();
  }

  /**
   * Low-level fetch wrapper for callers that need the Response object
   * itself (streaming downloads, non-JSON bodies, manual status handling).
   * Adds the engine base URL and credentials so callers don't have to
   * remember to set them. Use the typed `.get/.post/.put/.patch/.delete`
   * helpers for the common JSON-in/JSON-out flow.
   */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      credentials: 'include',
      ...init,
      headers: { ...(init.headers ?? {}) },
    });
  }

  get<T>(path: string) {
    return this.request<T>('GET', path);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  post<T>(path: string, body?: any) {
    return this.request<T>('POST', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  put<T>(path: string, body: any) {
    return this.request<T>('PUT', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  patch<T>(path: string, body: any) {
    return this.request<T>('PATCH', path, body);
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  delete<T>(path: string, body?: any) {
    return this.request<T>('DELETE', path, body);
  }
}

export const api = new ApiClient(ENGINE_URL);

// Short-lived in-memory cache to prevent duplicate requests when switching tabs.
// collections/list and field-types rarely change — 30s TTL is safe.
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}
// biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
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
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  list: () => cached('collections:list', () => api.get<{ collections: any[] }>('/api/collections')),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get: (name: string) => api.get<{ collection: any }>(`/api/collections/${name}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  create: (data: any) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.post<{ collection: any; job_id: string }>('/api/collections', data).then((r) => {
      invalidateCollectionsCache();
      return r;
    }),
  delete: (name: string) =>
    api.delete(`/api/collections/${name}`).then((r) => {
      invalidateCollectionsCache();
      return r;
    }),
  fieldTypes: () =>
    cached('collections:field-types', () =>
      // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
      api.get<{ field_types: any[] }>('/api/collections/field-types'),
    ),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  jobStatus: (jobId: string) => api.get<{ job: any }>(`/api/collections/jobs/${jobId}`),
};

export const dataApi = {
  list: (collection: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    return api.get<{ records: any[]; pagination: any }>(`/api/data/${collection}${qs}`);
  },
  // Note: GET/POST/PATCH return the record directly (no { record: ... } wrapper)
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get: (collection: string, id: string) => api.get<any>(`/api/data/${collection}/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  create: (collection: string, data: any) => api.post<any>(`/api/data/${collection}`, data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  update: (collection: string, id: string, data: any) =>
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    api.patch<any>(`/api/data/${collection}/${id}`, data),
  delete: (collection: string, id: string) => api.delete(`/api/data/${collection}/${id}`),
  bulkDelete: (collection: string, ids: string[]) =>
    api.delete<{ deleted: number }>(`/api/data/${collection}/bulk`, { ids }),
};

export const usersApi = {
  list: async (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ users: any[]; pagination: any }>(`/api/users${qs}`);
    return data.users || [];
  },
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get: (id: string) => api.get<{ user: any }>(`/api/users/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  invite: (data: any) => api.post<{ user: any }>('/api/users/invite', data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  update: (id: string, data: any) => api.patch<{ user: any }>(`/api/users/${id}`, data),
  delete: (id: string) => api.delete(`/api/users/${id}`),
};

export const settingsApi = {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  getAll: () => api.get<Record<string, any>>('/api/settings'),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  getPublic: () => api.get<Record<string, any>>('/api/settings/public'),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  update: (key: string, value: any) => api.put(`/api/settings/${key}`, { value }),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  updateBulk: (data: Record<string, any>) => api.patch('/api/settings/bulk', data),
};

export const webhooksApi = {
  list: async () => {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    const data = await api.get<{ webhooks: any[] }>('/api/webhooks');
    return data.webhooks || [];
  },
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  get: (id: string) => api.get<{ webhook: any }>(`/api/webhooks/${id}`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  create: (data: any) => api.post<{ webhook: any }>('/api/webhooks', data),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  update: (id: string, data: any) => api.patch<{ webhook: any }>(`/api/webhooks/${id}`, data),
  delete: (id: string) => api.delete(`/api/webhooks/${id}`),
  test: (id: string) => api.post(`/api/webhooks/${id}/test`),
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  deliveries: (id: string) => api.get<{ deliveries: any[] }>(`/api/webhooks/${id}/deliveries`),
};

export const importApi = {
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
  jobs: () => api.get<{ jobs: any[] }>('/ext/data/import/jobs'),
};

/**
 * Sites — what zones became when portals and page-builder merged.
 *
 * The engine stopped answering `/api/zones` when portals was extracted into an
 * extension, and every caller here kept asking: the intranet, the client portal
 * and this helper all 404'd. The name is kept so existing call sites read
 * unchanged; the routes are the extension's.
 */
/**
 * One loose `any` for the whole helper, rather than a suppression comment on
 * every line. Reflowing moved those comments off the lines they covered, which
 * is the trouble with a per-line suppression on code a formatter owns.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped extension payloads; tracked in docs/HARDENING-9-PLAN.md H-01
type Json = any;

export const sitesApi = {
  list: () => api.get<{ sites: Json[] }>('/ext/content/pages/sites'),
  create: (data: Json) => api.post<{ site: Json }>('/ext/content/pages/sites', data),
  get: (slug: string) => api.get<{ site: Json }>(`/ext/content/pages/sites/${slug}`),
  update: (slug: string, data: Json) =>
    api.put<{ site: Json }>(`/ext/content/pages/sites/${slug}`, data),
  delete: (slug: string) => api.delete(`/ext/content/pages/sites/${slug}`),

  listPages: (slug: string) => api.get<{ pages: Json[] }>(`/ext/content/pages/sites/${slug}/pages`),
  createPage: (slug: string, data: Json) =>
    api.post<{ page: Json }>(`/ext/content/pages/sites/${slug}/pages`, data),
  updatePage: (slug: string, pageSlug: string, data: Json) =>
    api.put<{ page: Json }>(`/ext/content/pages/sites/${slug}/pages/${pageSlug}`, data),
  deletePage: (slug: string, pageSlug: string) =>
    api.delete(`/ext/content/pages/sites/${slug}/pages/${pageSlug}`),
  reorderPages: (slug: string, ids: string[]) =>
    api.post(`/ext/content/pages/sites/${slug}/pages/reorder`, { ids }),

  // The render endpoints answer `site` and `blocks` — zones became sites and a
  // page's views became its blocks when the two extensions merged.
  render: (slug: string) =>
    api.get<{ site: Json; nav: Json[] }>(`/ext/content/pages/sites/${slug}/render`),
  renderPage: (slug: string, pageSlug: string) =>
    api.get<{ page: Json; site: Json; blocks: Json[]; record: Json }>(
      `/ext/content/pages/sites/${slug}/render/${pageSlug}`,
    ),
};

/** The name this had while zones were zones. */
export const zonesApi = sitesApi;

/**
 * Views are gone.
 *
 * A view was "show rows of a collection, filtered and sorted", which is what a
 * `collection_list` BLOCK is — so views became blocks when portals and
 * page-builder merged, and `/api/views` stopped existing with them. Nothing in
 * the Studio calls this any more; it is removed rather than left pointing at a
 * route that answers 404.
 */
